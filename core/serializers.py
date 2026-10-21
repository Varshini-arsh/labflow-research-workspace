from django.contrib.auth.models import User
from rest_framework import serializers

from .models import Activity, Comment, Project, Publication, Task
from .permissions import can_edit_task


class UserSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()
    role = serializers.CharField(source="profile.role", read_only=True)
    role_label = serializers.CharField(source="profile.get_role_display", read_only=True)
    title = serializers.CharField(source="profile.title", read_only=True)
    color = serializers.CharField(source="profile.color", read_only=True)

    class Meta:
        model = User
        fields = ["id", "username", "name", "initials", "role", "role_label", "title", "color"]

    def get_name(self, obj):
        return obj.get_full_name() or obj.username

    def get_initials(self, obj):
        parts = (obj.get_full_name() or obj.username).split()
        return "".join(p[0] for p in parts[:2]).upper()


class ProjectSerializer(serializers.ModelSerializer):
    lead = UserSerializer(read_only=True)
    lead_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), source="lead", write_only=True, required=False, allow_null=True
    )
    members = UserSerializer(many=True, read_only=True)
    member_ids = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), source="members", many=True, write_only=True, required=False
    )
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    task_count = serializers.IntegerField(read_only=True, default=0)
    done_count = serializers.IntegerField(read_only=True, default=0)
    overdue_count = serializers.IntegerField(read_only=True, default=0)
    progress = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            "id", "name", "code", "description", "status", "status_label", "color",
            "lead", "lead_id", "members", "member_ids", "start_date", "due_date",
            "task_count", "done_count", "overdue_count", "progress", "created_at",
        ]

    def get_progress(self, obj):
        total = getattr(obj, "task_count", 0) or 0
        return round(100 * (getattr(obj, "done_count", 0) or 0) / total) if total else 0

    def validate_code(self, value):
        return value.strip().upper()

    def validate(self, attrs):
        start, due = attrs.get("start_date"), attrs.get("due_date")
        if start and due and due < start:
            raise serializers.ValidationError({"due_date": "Due date cannot be before the start date."})
        return attrs


class TaskSerializer(serializers.ModelSerializer):
    assignee = UserSerializer(read_only=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), source="assignee", write_only=True, required=False, allow_null=True
    )
    project_id = serializers.PrimaryKeyRelatedField(queryset=Project.objects.all(), source="project")
    project_name = serializers.CharField(source="project.name", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True)
    project_color = serializers.CharField(source="project.color", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    priority_label = serializers.CharField(source="get_priority_display", read_only=True)
    comment_count = serializers.IntegerField(read_only=True, default=0)
    is_overdue = serializers.BooleanField(read_only=True)
    tag_list = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id", "project_id", "project_name", "project_code", "project_color",
            "title", "description", "status", "status_label", "priority", "priority_label",
            "assignee", "assignee_id", "due_date", "position", "tags", "tag_list",
            "comment_count", "is_overdue", "can_edit", "created_at", "updated_at", "completed_at",
        ]
        read_only_fields = ["position", "completed_at"]

    def get_tag_list(self, obj):
        return [t.strip() for t in obj.tags.split(",") if t.strip()]

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and can_edit_task(request.user, obj))


class CommentSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)

    class Meta:
        model = Comment
        fields = ["id", "author", "body", "created_at"]

    def validate_body(self, value):
        if not value.strip():
            raise serializers.ValidationError("Comment cannot be empty.")
        return value.strip()


class PublicationSerializer(serializers.ModelSerializer):
    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), source="project", required=False, allow_null=True
    )
    project_code = serializers.CharField(source="project.code", read_only=True, default=None)
    project_color = serializers.CharField(source="project.color", read_only=True, default=None)
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = Publication
        fields = [
            "id", "title", "authors", "venue", "year", "status", "status_label",
            "project_id", "project_code", "project_color", "doi", "updated_at",
        ]


class ActivitySerializer(serializers.ModelSerializer):
    actor = UserSerializer(read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True, default=None)
    project_color = serializers.CharField(source="project.color", read_only=True, default=None)

    class Meta:
        model = Activity
        fields = ["id", "actor", "verb", "target", "project_code", "project_color", "created_at"]
