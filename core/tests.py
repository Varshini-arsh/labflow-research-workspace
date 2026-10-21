from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Activity, Profile, Project, Task


def make_user(username, role):
    user = User.objects.create_user(username=username, password="pass12345", first_name=username.title())
    Profile.objects.filter(user=user).update(role=role)
    user.refresh_from_db()
    return user


class LabFlowAPITests(APITestCase):
    def setUp(self):
        self.admin = make_user("admin", Profile.Role.ADMIN)
        self.researcher = make_user("res", Profile.Role.RESEARCHER)
        self.intern = make_user("intern", Profile.Role.INTERN)
        self.other_intern = make_user("intern2", Profile.Role.INTERN)
        self.project = Project.objects.create(name="Grid", code="GRID", lead=self.researcher)
        self.project.members.add(self.researcher, self.intern)

    def task(self, **kwargs):
        defaults = {"project": self.project, "title": "Task", "created_by": self.researcher}
        defaults.update(kwargs)
        return Task.objects.create(**defaults)

    # --- auth & roles ---
    def test_api_requires_login(self):
        self.assertEqual(self.client.get("/api/tasks/").status_code, 403)

    def test_intern_cannot_create_project(self):
        self.client.force_authenticate(self.intern)
        res = self.client.post("/api/projects/", {"name": "X", "code": "X1"}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_researcher_creates_project_and_becomes_lead_member(self):
        self.client.force_authenticate(self.researcher)
        res = self.client.post("/api/projects/", {"name": "Energy", "code": "nrg"}, format="json")
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(code="NRG")  # code is upper-cased
        self.assertEqual(project.lead, self.researcher)
        self.assertIn(self.researcher, project.members.all())
        self.assertTrue(Activity.objects.filter(verb="created project").exists())

    def test_due_date_before_start_is_rejected(self):
        self.client.force_authenticate(self.researcher)
        res = self.client.post(
            "/api/projects/", {"name": "Bad", "code": "BAD", "start_date": "2026-05-10", "due_date": "2026-05-01"}, format="json"
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("due_date", res.json())

    def test_only_admin_can_delete_project(self):
        self.client.force_authenticate(self.researcher)
        self.assertEqual(self.client.delete(f"/api/projects/{self.project.id}/").status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.delete(f"/api/projects/{self.project.id}/").status_code, 204)

    def test_intern_can_edit_only_own_tasks(self):
        mine = self.task(assignee=self.intern)
        theirs = self.task(assignee=self.other_intern)
        self.client.force_authenticate(self.intern)
        self.assertEqual(self.client.patch(f"/api/tasks/{mine.id}/", {"status": "review"}, format="json").status_code, 200)
        self.assertEqual(self.client.patch(f"/api/tasks/{theirs.id}/", {"status": "review"}, format="json").status_code, 403)
        listed = {t["id"]: t["can_edit"] for t in self.client.get("/api/tasks/").json()}
        self.assertTrue(listed[mine.id])
        self.assertFalse(listed[theirs.id])

    # --- task behaviour ---
    def test_completed_at_tracks_done_status(self):
        t = self.task()
        t.status = Task.Status.DONE
        t.save()
        self.assertIsNotNone(t.completed_at)
        t.status = Task.Status.REVIEW
        t.save()
        self.assertIsNone(t.completed_at)

    def test_move_inserts_and_renumbers_column(self):
        a = self.task(title="A", status="review", position=0)
        b = self.task(title="B", status="review", position=1)
        c = self.task(title="C", status="todo", position=0)
        self.client.force_authenticate(self.researcher)
        res = self.client.post(f"/api/tasks/{c.id}/move/", {"status": "review", "position": 1}, format="json")
        self.assertEqual(res.status_code, 200)
        order = list(Task.objects.filter(status="review").order_by("position").values_list("title", flat=True))
        self.assertEqual(order, ["A", "C", "B"])
        self.assertEqual(self.client.get(f"/api/tasks/?project={self.project.id}&status=review").json()[1]["title"], "C")

    def test_move_rejects_unknown_status(self):
        t = self.task()
        self.client.force_authenticate(self.researcher)
        res = self.client.post(f"/api/tasks/{t.id}/move/", {"status": "nope"}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_filters_overdue_and_search(self):
        yesterday = timezone.localdate() - timedelta(days=1)
        late = self.task(title="Late report", due_date=yesterday)
        self.task(title="Late but done", due_date=yesterday, status="done")
        self.task(title="Fine", due_date=yesterday + timedelta(days=5))
        self.client.force_authenticate(self.researcher)
        ids = [t["id"] for t in self.client.get("/api/tasks/?overdue=1").json()]
        self.assertEqual(ids, [late.id])
        titles = [t["title"] for t in self.client.get("/api/tasks/?search=late").json()]
        self.assertEqual(sorted(titles), ["Late but done", "Late report"])

    def test_comments_round_trip(self):
        t = self.task()
        self.client.force_authenticate(self.intern)
        self.assertEqual(self.client.post(f"/api/tasks/{t.id}/comments/", {"body": "  "}, format="json").status_code, 400)
        self.assertEqual(self.client.post(f"/api/tasks/{t.id}/comments/", {"body": "On it"}, format="json").status_code, 201)
        comments = self.client.get(f"/api/tasks/{t.id}/comments/").json()
        self.assertEqual(comments[0]["body"], "On it")
        self.assertEqual(comments[0]["author"]["username"], "intern")

    # --- dashboard (raw SQL workload) ---
    def test_dashboard_workload_counts(self):
        yesterday = timezone.localdate() - timedelta(days=1)
        self.task(assignee=self.intern, status="todo", due_date=yesterday)
        self.task(assignee=self.intern, status="in_progress")
        self.task(assignee=self.intern, status="done")
        self.client.force_authenticate(self.admin)
        data = self.client.get("/api/dashboard/").json()
        row = next(r for r in data["workload"] if r["user"]["username"] == "intern")
        self.assertEqual((row["open"], row["done"], row["overdue"]), (2, 1, 1))
        self.assertEqual(data["stats"]["overdue_tasks"], 1)
        self.assertEqual(data["stats"]["done_this_week"], 1)
        self.assertEqual(len(data["velocity"]), 8)
        self.assertEqual(sum(w["count"] for w in data["velocity"]), 1)
