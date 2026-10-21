from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class Profile(models.Model):
    class Role(models.TextChoices):
        ADMIN = "admin", "Lab Admin"
        RESEARCHER = "researcher", "Researcher"
        INTERN = "intern", "Intern"

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.INTERN)
    title = models.CharField(max_length=80, blank=True)
    color = models.CharField(max_length=7, default="#6366f1")

    def __str__(self):
        return f"{self.user.username} ({self.role})"


class Project(models.Model):
    class Status(models.TextChoices):
        PLANNING = "planning", "Planning"
        ACTIVE = "active", "Active"
        ON_HOLD = "on_hold", "On hold"
        COMPLETED = "completed", "Completed"

    name = models.CharField(max_length=120)
    code = models.CharField(max_length=12, unique=True)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    color = models.CharField(max_length=7, default="#2a78d6")
    lead = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="led_projects")
    members = models.ManyToManyField(User, blank=True, related_name="projects")
    start_date = models.DateField(default=timezone.localdate)
    due_date = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.code} · {self.name}"


class Task(models.Model):
    class Status(models.TextChoices):
        TODO = "todo", "To do"
        IN_PROGRESS = "in_progress", "In progress"
        REVIEW = "review", "In review"
        DONE = "done", "Done"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.TODO)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    assignee = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    due_date = models.DateField(null=True, blank=True)
    position = models.PositiveIntegerField(default=0)
    tags = models.CharField(max_length=200, blank=True, help_text="Comma-separated")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["position", "-created_at"]
        indexes = [
            models.Index(fields=["project", "status"]),
            models.Index(fields=["assignee", "status"]),
            models.Index(fields=["due_date"]),
        ]

    def save(self, *args, **kwargs):
        if self.status == self.Status.DONE and self.completed_at is None:
            self.completed_at = timezone.now()
        elif self.status != self.Status.DONE:
            self.completed_at = None
        super().save(*args, **kwargs)

    @property
    def is_overdue(self):
        return bool(self.due_date and self.status != self.Status.DONE and self.due_date < timezone.localdate())

    def __str__(self):
        return self.title


class Comment(models.Model):
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class Publication(models.Model):
    class Status(models.TextChoices):
        IDEA = "idea", "Idea"
        DRAFTING = "drafting", "Drafting"
        SUBMITTED = "submitted", "Submitted"
        ACCEPTED = "accepted", "Accepted"
        PUBLISHED = "published", "Published"

    title = models.CharField(max_length=250)
    authors = models.CharField(max_length=300)
    venue = models.CharField(max_length=150, blank=True)
    year = models.PositiveSmallIntegerField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.IDEA)
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL, related_name="publications")
    doi = models.CharField(max_length=120, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title


class Activity(models.Model):
    actor = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    verb = models.CharField(max_length=60)
    target = models.CharField(max_length=200)
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.CASCADE, related_name="activity")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name_plural = "activities"


def log_activity(actor, verb, target, project=None):
    Activity.objects.create(actor=actor, verb=verb, target=str(target)[:200], project=project)
