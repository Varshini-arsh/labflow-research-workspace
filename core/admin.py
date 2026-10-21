from django.contrib import admin

from .models import Activity, Comment, Profile, Project, Publication, Task


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ["user", "role", "title"]
    list_filter = ["role"]


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["code", "name", "status", "lead", "due_date"]
    list_filter = ["status"]
    search_fields = ["name", "code"]
    filter_horizontal = ["members"]


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ["title", "project", "status", "priority", "assignee", "due_date"]
    list_filter = ["status", "priority", "project"]
    search_fields = ["title", "tags"]


admin.site.register(Comment)
admin.site.register(Publication)
admin.site.register(Activity)
