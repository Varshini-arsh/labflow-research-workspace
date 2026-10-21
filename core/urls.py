from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("users", views.UserViewSet, basename="user")
router.register("projects", views.ProjectViewSet, basename="project")
router.register("tasks", views.TaskViewSet, basename="task")
router.register("publications", views.PublicationViewSet, basename="publication")
router.register("activity", views.ActivityViewSet, basename="activity")

urlpatterns = [
    path("me/", views.me, name="me"),
    path("dashboard/", views.dashboard, name="dashboard"),
] + router.urls
