"""Role rules, kept in one place so views and tests share them.

- Lab Admin: everything.
- Researcher: create projects; edit projects they lead; edit any task.
- Intern: edit tasks assigned to or created by them; comment anywhere.
"""
from .models import Profile


def role_of(user):
    if user.is_superuser:
        return Profile.Role.ADMIN
    profile = getattr(user, "profile", None)
    return profile.role if profile else Profile.Role.INTERN


def is_admin(user):
    return role_of(user) == Profile.Role.ADMIN


def can_create_project(user):
    return role_of(user) in (Profile.Role.ADMIN, Profile.Role.RESEARCHER)


def can_edit_project(user, project):
    return is_admin(user) or project.lead_id == user.id


def can_edit_task(user, task):
    if role_of(user) in (Profile.Role.ADMIN, Profile.Role.RESEARCHER):
        return True
    return user.id in (task.assignee_id, task.created_by_id)


def can_delete_task(user, task):
    return is_admin(user) or task.project.lead_id == user.id or task.created_by_id == user.id
