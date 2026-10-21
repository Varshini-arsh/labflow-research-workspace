from datetime import timedelta

from django.contrib.auth.models import User
from django.db import connection, transaction
from django.db.models import Count, Max, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import permissions as perms
from .models import Activity, Comment, Project, Publication, Task, log_activity
from .serializers import (
    ActivitySerializer,
    CommentSerializer,
    ProjectSerializer,
    PublicationSerializer,
    TaskSerializer,
    UserSerializer,
)


@api_view(["GET"])
def me(request):
    user = request.user
    data = UserSerializer(user).data
    data["can"] = {
        "create_project": perms.can_create_project(user),
        "admin": perms.is_admin(user),
    }
    return Response(data)


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = UserSerializer

    def get_queryset(self):
        return User.objects.filter(is_active=True).select_related("profile").order_by("first_name", "username")


def project_queryset():
    today = timezone.localdate()
    return (
        Project.objects.select_related("lead__profile")
        .prefetch_related("members__profile")
        .annotate(
            task_count=Count("tasks", distinct=True),
            done_count=Count("tasks", filter=Q(tasks__status=Task.Status.DONE), distinct=True),
            overdue_count=Count(
                "tasks",
                filter=Q(tasks__due_date__lt=today) & ~Q(tasks__status=Task.Status.DONE),
                distinct=True,
            ),
        )
        .order_by("-created_at")
    )


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer

    def get_queryset(self):
        qs = project_queryset()
        status_filter = self.request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)
        return qs

    def perform_create(self, serializer):
        user = self.request.user
        if not perms.can_create_project(user):
            raise PermissionDenied("Only researchers and admins can create projects.")
        lead = serializer.validated_data.get("lead") or user
        project = serializer.save(lead=lead)
        project.members.add(lead)
        log_activity(user, "created project", project.name, project)

    def perform_update(self, serializer):
        if not perms.can_edit_project(self.request.user, serializer.instance):
            raise PermissionDenied("Only the project lead or an admin can edit this project.")
        project = serializer.save()
        if project.lead_id:
            project.members.add(project.lead_id)
        log_activity(self.request.user, "updated project", project.name, project)

    def perform_destroy(self, instance):
        if not perms.is_admin(self.request.user):
            raise PermissionDenied("Only admins can delete projects.")
        log_activity(self.request.user, "deleted project", instance.name)
        instance.delete()


class TaskViewSet(viewsets.ModelViewSet):
    serializer_class = TaskSerializer

    def get_queryset(self):
        params = self.request.query_params
        # Explicit order_by: Meta.ordering is dropped from GROUP BY (annotated) queries.
        qs = (
            Task.objects.select_related("project", "assignee__profile")
            .annotate(comment_count=Count("comments"))
            .order_by("position", "-created_at")
        )
        if params.get("project"):
            qs = qs.filter(project_id=params["project"])
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("priority"):
            qs = qs.filter(priority__in=params["priority"].split(","))
        if params.get("assignee") == "me":
            qs = qs.filter(assignee=self.request.user)
        elif params.get("assignee"):
            qs = qs.filter(assignee_id=params["assignee"])
        if params.get("overdue") == "1":
            qs = qs.filter(due_date__lt=timezone.localdate()).exclude(status=Task.Status.DONE)
        if params.get("search"):
            term = params["search"]
            qs = qs.filter(Q(title__icontains=term) | Q(description__icontains=term) | Q(tags__icontains=term))
        return qs

    def perform_create(self, serializer):
        status_value = serializer.validated_data.get("status", Task.Status.TODO)
        project = serializer.validated_data["project"]
        last = Task.objects.filter(project=project, status=status_value).aggregate(m=Max("position"))["m"]
        task = serializer.save(created_by=self.request.user, position=(last or 0) + 1)
        log_activity(self.request.user, "created task", task.title, task.project)

    def perform_update(self, serializer):
        task = serializer.instance
        if not perms.can_edit_task(self.request.user, task):
            raise PermissionDenied("Interns can only edit tasks assigned to them.")
        old_status = task.status
        task = serializer.save()
        if task.status != old_status:
            log_activity(self.request.user, f"moved to {task.get_status_display()}", task.title, task.project)
        else:
            log_activity(self.request.user, "updated task", task.title, task.project)

    def perform_destroy(self, instance):
        if not perms.can_delete_task(self.request.user, instance):
            raise PermissionDenied("You can only delete tasks you created (or as project lead/admin).")
        log_activity(self.request.user, "deleted task", instance.title, instance.project)
        instance.delete()

    @action(detail=True, methods=["post"])
    def move(self, request, pk=None):
        """Drag-and-drop: put the task in `status` at index `position` and renumber that column."""
        task = get_object_or_404(Task, pk=pk)
        if not perms.can_edit_task(request.user, task):
            raise PermissionDenied("Interns can only move tasks assigned to them.")
        new_status = request.data.get("status", task.status)
        if new_status not in Task.Status.values:
            raise ValidationError({"status": "Unknown status."})
        try:
            index = max(0, int(request.data.get("position", 0)))
        except (TypeError, ValueError):
            raise ValidationError({"position": "Must be an integer."})

        old_status = task.status
        with transaction.atomic():
            column = list(
                Task.objects.select_for_update()
                .filter(project=task.project, status=new_status)
                .exclude(pk=task.pk)
                .order_by("position", "-created_at")
            )
            column.insert(min(index, len(column)), task)
            task.status = new_status
            task.save()
            for i, t in enumerate(column):
                if t.position != i:
                    Task.objects.filter(pk=t.pk).update(position=i)
        if new_status != old_status:
            log_activity(request.user, f"moved to {task.get_status_display()}", task.title, task.project)
        task = self.get_queryset().get(pk=task.pk)
        return Response(TaskSerializer(task, context={"request": request}).data)

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, pk=None):
        task = get_object_or_404(Task, pk=pk)
        if request.method == "POST":
            serializer = CommentSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            serializer.save(task=task, author=request.user)
            log_activity(request.user, "commented on", task.title, task.project)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        comments = Comment.objects.filter(task=task).select_related("author__profile")
        return Response(CommentSerializer(comments, many=True).data)


class PublicationViewSet(viewsets.ModelViewSet):
    serializer_class = PublicationSerializer

    def get_queryset(self):
        qs = Publication.objects.select_related("project")
        if self.request.query_params.get("status"):
            qs = qs.filter(status=self.request.query_params["status"])
        return qs

    def perform_create(self, serializer):
        pub = serializer.save()
        log_activity(self.request.user, "added publication", pub.title, pub.project)

    def perform_update(self, serializer):
        old_status = serializer.instance.status
        pub = serializer.save()
        verb = f"marked paper {pub.get_status_display()}" if pub.status != old_status else "updated publication"
        log_activity(self.request.user, verb, pub.title, pub.project)

    def perform_destroy(self, instance):
        if perms.role_of(self.request.user) == "intern":
            raise PermissionDenied("Interns cannot delete publications.")
        instance.delete()


class ActivityViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = ActivitySerializer

    def get_queryset(self):
        qs = Activity.objects.select_related("actor__profile", "project")
        if self.request.query_params.get("project"):
            qs = qs.filter(project_id=self.request.query_params["project"])
        return qs[:60]


WORKLOAD_SQL = """
    SELECT u.id,
           SUM(CASE WHEN t.id IS NOT NULL AND t.status <> 'done' THEN 1 ELSE 0 END) AS open_tasks,
           SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)                        AS done_tasks,
           SUM(CASE WHEN t.status <> 'done' AND t.due_date < %s THEN 1 ELSE 0 END)   AS overdue_tasks
    FROM auth_user u
    LEFT JOIN core_task t ON t.assignee_id = u.id
    WHERE u.is_active = %s
    GROUP BY u.id
    ORDER BY open_tasks DESC
"""


def team_workload(today):
    """Per-member task counts. Hand-written SQL (JOIN + GROUP BY + conditional SUM),
    portable across SQLite and MySQL."""
    with connection.cursor() as cursor:
        cursor.execute(WORKLOAD_SQL, [today, True])
        rows = cursor.fetchall()
    users = {u.id: u for u in User.objects.filter(id__in=[r[0] for r in rows]).select_related("profile")}
    return [
        {"user": UserSerializer(users[r[0]]).data, "open": int(r[1] or 0), "done": int(r[2] or 0), "overdue": int(r[3] or 0)}
        for r in rows
        if r[0] in users
    ]


@api_view(["GET"])
def dashboard(request):
    today = timezone.localdate()
    now = timezone.now()
    tasks = Task.objects.all()
    open_tasks = tasks.exclude(status=Task.Status.DONE)

    status_counts = dict(tasks.values_list("status").annotate(n=Count("id")))
    week_start = today - timedelta(days=today.weekday())

    # Tasks completed per week, last 8 weeks (bucketed in Python so it is DB-agnostic).
    weeks = [week_start - timedelta(weeks=i) for i in range(7, -1, -1)]
    completed = tasks.filter(completed_at__gte=now - timedelta(weeks=9)).values_list("completed_at", flat=True)
    per_week = {w: 0 for w in weeks}
    for ts in completed:
        d = timezone.localtime(ts).date()
        bucket = d - timedelta(days=d.weekday())
        if bucket in per_week:
            per_week[bucket] += 1

    upcoming = (
        open_tasks.filter(due_date__gte=today, due_date__lte=today + timedelta(days=10))
        .select_related("project", "assignee__profile")
        .annotate(comment_count=Count("comments"))
        .order_by("due_date")[:8]
    )
    project_qs = project_queryset().exclude(status=Project.Status.COMPLETED)

    return Response(
        {
            "stats": {
                "active_projects": Project.objects.filter(status=Project.Status.ACTIVE).count(),
                "open_tasks": open_tasks.count(),
                "overdue_tasks": open_tasks.filter(due_date__lt=today).count(),
                "done_this_week": tasks.filter(completed_at__date__gte=week_start).count(),
                "my_open_tasks": open_tasks.filter(assignee=request.user).count(),
                "papers_in_pipeline": Publication.objects.exclude(status=Publication.Status.PUBLISHED).count(),
            },
            "status_breakdown": [
                {"status": value, "label": label, "count": status_counts.get(value, 0)}
                for value, label in Task.Status.choices
            ],
            "velocity": [{"week": w.isoformat(), "count": per_week[w]} for w in weeks],
            "workload": team_workload(today),
            "projects": ProjectSerializer(project_qs, many=True).data,
            "upcoming": TaskSerializer(upcoming, many=True, context={"request": request}).data,
        }
    )
