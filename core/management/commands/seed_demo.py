"""Load the case-study dataset: a small university research lab running five projects.

    python manage.py seed_demo          # wipe LabFlow data and reload
"""
import random
from datetime import timedelta

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from core.models import Activity, Comment, Profile, Project, Publication, Task

DEMO_PASSWORD = "demo12345"

PEOPLE = [
    # username, first, last, role, title, color
    ("ananya", "Ananya", "Iyer", Profile.Role.ADMIN, "Lab Director", "#2a78d6"),
    ("rahul", "Rahul", "Menon", Profile.Role.RESEARCHER, "Senior Research Engineer", "#eb6834"),
    ("priya", "Priya", "Sharma", Profile.Role.RESEARCHER, "ML Researcher", "#1baf7a"),
    ("arjun", "Arjun", "Rao", Profile.Role.RESEARCHER, "Backend Engineer", "#6250d6"),
    ("meera", "Meera", "Nair", Profile.Role.INTERN, "Full-stack Intern", "#e87ba4"),
    ("kiran", "Kiran", "Das", Profile.Role.INTERN, "Data Intern", "#008300"),
    ("sneha", "Sneha", "Pillai", Profile.Role.INTERN, "Frontend Intern", "#eda100"),
]

PROJECTS = [
    {
        "code": "GRID", "name": "Smart Grid Battery Analytics", "lead": "rahul", "color": "#2a78d6",
        "status": Project.Status.ACTIVE, "start": -70, "due": 40,
        "members": ["rahul", "kiran", "meera", "priya"],
        "description": "Predict state-of-health for grid-scale Li-ion packs from BMS telemetry and flag cells at risk of thermal events.",
        "tasks": [
            ("Ingest 6 months of BMS telemetry into MySQL", "done", "high", "kiran", -40, "data,etl"),
            ("Clean voltage spikes and missing readings", "done", "medium", "kiran", -30, "data"),
            ("Baseline SoH model (gradient boosting)", "done", "high", "priya", -18, "ml"),
            ("REST endpoint: /cells/{id}/health", "review", "high", "meera", 2, "api,django"),
            ("Thermal anomaly alert rules", "in_progress", "urgent", "rahul", -2, "alerts"),
            ("Cell health heatmap on dashboard", "in_progress", "medium", "meera", 6, "frontend"),
            ("Write unit tests for ingestion jobs", "todo", "medium", "kiran", 9, "testing"),
            ("Compare LSTM vs GBM on 30-day horizon", "todo", "low", "priya", 20, "ml,research"),
            ("Weekly report export (CSV + PDF)", "todo", "low", None, 25, "reports"),
        ],
    },
    {
        "code": "ZKRWA", "name": "ZKP Compliance for Tokenized Assets", "lead": "priya", "color": "#6250d6",
        "status": Project.Status.ACTIVE, "start": -50, "due": 30,
        "members": ["priya", "arjun", "meera"],
        "description": "Prove investor eligibility (KYC tier, jurisdiction) with zero-knowledge proofs before ERC-3643 token transfers - without revealing personal data.",
        "tasks": [
            ("Literature review: ZK credential schemes", "done", "medium", "priya", -35, "research"),
            ("Define eligibility circuit constraints", "done", "high", "priya", -20, "zkp"),
            ("Verifier contract gas benchmarks", "review", "high", "arjun", 1, "blockchain,benchmark"),
            ("Proof submission API + retry queue", "in_progress", "high", "arjun", 5, "api"),
            ("Investor onboarding UI mock-ups", "in_progress", "medium", "meera", 4, "frontend,ux"),
            ("Threat model document", "todo", "urgent", "priya", -1, "security"),
            ("End-to-end demo on testnet", "todo", "high", None, 18, "demo"),
        ],
    },
    {
        "code": "CAMPUS", "name": "Campus Energy Dashboard", "lead": "arjun", "color": "#1baf7a",
        "status": Project.Status.ACTIVE, "start": -30, "due": 55,
        "members": ["arjun", "sneha", "kiran", "rahul"],
        "description": "A public dashboard showing live electricity and solar generation per campus building, with weekly savings tips.",
        "tasks": [
            ("Meter data schema + migrations", "done", "high", "arjun", -14, "database,django"),
            ("Building list page (responsive)", "done", "medium", "sneha", -8, "frontend"),
            ("Hourly aggregation SQL views", "in_progress", "high", "kiran", 3, "sql"),
            ("Solar vs grid stacked chart", "in_progress", "medium", "sneha", 7, "frontend,charts"),
            ("Auth for facilities team", "todo", "medium", "arjun", 12, "auth"),
            ("Accessibility audit (WCAG AA)", "todo", "low", "sneha", 21, "a11y"),
            ("Load test with 1 yr of readings", "todo", "medium", None, 28, "performance"),
            ("Fix timezone bug in daily totals", "review", "urgent", "kiran", -3, "bug"),
        ],
    },
    {
        "code": "AGRI", "name": "Crop Yield Forecasting", "lead": "priya", "color": "#eda100",
        "status": Project.Status.PLANNING, "start": 5, "due": 120,
        "members": ["priya", "kiran"],
        "description": "Combine satellite NDVI and rainfall data to forecast district-level paddy yield for farmer advisories.",
        "tasks": [
            ("Collect district rainfall datasets", "todo", "medium", "kiran", 15, "data"),
            ("Project proposal for funding round", "in_progress", "high", "priya", 8, "writing"),
            ("Shortlist satellite data providers", "todo", "low", None, 30, "research"),
        ],
    },
    {
        "code": "WEB", "name": "Lab Website Revamp", "lead": "arjun", "color": "#eb6834",
        "status": Project.Status.COMPLETED, "start": -90, "due": -10,
        "members": ["arjun", "sneha", "meera"],
        "description": "Rebuilt the lab website with a people directory, publication list and project pages.",
        "tasks": [
            ("Design system + colour tokens", "done", "medium", "sneha", -60, "design"),
            ("People directory with filters", "done", "medium", "meera", -45, "frontend"),
            ("Publications page from database", "done", "high", "arjun", -32, "django"),
            ("Deploy + set up HTTPS", "done", "high", "arjun", -12, "devops"),
        ],
    },
]

COMMENTS = [
    ("Thermal anomaly alert rules", "priya", "Can we use the 95th percentile of cell temp delta as the first threshold?"),
    ("Thermal anomaly alert rules", "rahul", "Yes - starting there, will tune after we see false positives."),
    ("REST endpoint: /cells/{id}/health", "meera", "PR is up. Added pagination and a 404 for unknown cells."),
    ("REST endpoint: /cells/{id}/health", "rahul", "Looks good. Please add a test for the 404 case."),
    ("Verifier contract gas benchmarks", "arjun", "Groth16 verify is ~210k gas; PLONK ~290k. Table in the doc."),
    ("Fix timezone bug in daily totals", "kiran", "Root cause: readings stored in UTC, grouped by local date. Fixed with CONVERT_TZ."),
    ("Hourly aggregation SQL views", "arjun", "Add an index on (meter_id, read_at) before running this on the full table."),
    ("Investor onboarding UI mock-ups", "priya", "Keep the KYC step to one screen if possible."),
]

PUBLICATIONS = [
    ("Privacy-Preserving Eligibility Proofs for Permissioned Security Tokens", "P. Sharma, A. Rao, A. Iyer", "IEEE Blockchain", 2026, Publication.Status.SUBMITTED, "ZKRWA", ""),
    ("Early Thermal-Risk Detection in Grid Batteries from BMS Telemetry", "R. Menon, K. Das, P. Sharma", "Applied Energy", 2026, Publication.Status.DRAFTING, "GRID", ""),
    ("Gas Costs of On-chain ZK Verifiers: A Practical Benchmark", "A. Rao, P. Sharma", "arXiv preprint", 2026, Publication.Status.PUBLISHED, "ZKRWA", "10.48550/arXiv.2609.01234"),
    ("Open Campus Energy Data for Behavioural Savings", "A. Rao, S. Pillai, R. Menon", "ACM e-Energy", 2027, Publication.Status.IDEA, "CAMPUS", ""),
    ("A Lightweight SoH Estimator for Second-Life Batteries", "R. Menon, A. Iyer", "IEEE SmartGridComm", 2025, Publication.Status.ACCEPTED, "GRID", ""),
    ("NDVI-Rainfall Fusion for District Yield Forecasts", "P. Sharma, K. Das", "", None, Publication.Status.IDEA, "AGRI", ""),
]


class Command(BaseCommand):
    help = "Reset LabFlow data and load the research-lab case study."

    @transaction.atomic
    def handle(self, *args, **options):
        rng = random.Random(42)
        today = timezone.localdate()
        now = timezone.now()

        Activity.objects.all().delete()
        Publication.objects.all().delete()
        Project.objects.all().delete()  # cascades tasks + comments
        User.objects.filter(username__in=[p[0] for p in PEOPLE]).delete()

        users = {}
        for username, first, last, role, title, color in PEOPLE:
            user = User.objects.create_user(
                username=username, password=DEMO_PASSWORD, first_name=first, last_name=last,
                email=f"{username}@lab.example", is_staff=(role == Profile.Role.ADMIN),
                is_superuser=(role == Profile.Role.ADMIN),
            )
            Profile.objects.filter(user=user).update(role=role, title=title, color=color)
            users[username] = user

        tasks_by_title = {}
        for spec in PROJECTS:
            project = Project.objects.create(
                code=spec["code"], name=spec["name"], description=spec["description"],
                status=spec["status"], color=spec["color"], lead=users[spec["lead"]],
                start_date=today + timedelta(days=spec["start"]), due_date=today + timedelta(days=spec["due"]),
            )
            project.members.set([users[u] for u in spec["members"]])
            positions = {}
            for title, status, priority, assignee, due, tags in spec["tasks"]:
                positions[status] = positions.get(status, -1) + 1
                task = Task.objects.create(
                    project=project, title=title, status=status, priority=priority,
                    assignee=users.get(assignee), created_by=users[spec["lead"]],
                    due_date=today + timedelta(days=due), position=positions[status], tags=tags,
                    description=f"Part of {spec['name']}. Tags: {tags.replace(',', ', ')}.",
                )
                created = now - timedelta(days=max(abs(due) + rng.randint(5, 15), 3))
                update = {"created_at": created}
                if status == Task.Status.DONE:
                    # Spread completions across the last 8 weeks so the velocity chart has shape,
                    # with a few landing this week.
                    days_ago = rng.randint(0, 2) if len(tasks_by_title) % 4 == 0 else rng.randint(3, 55)
                    update["completed_at"] = now - timedelta(days=days_ago, hours=rng.randint(0, 6))
                Task.objects.filter(pk=task.pk).update(**update)
                tasks_by_title[title] = task

        for i, (task_title, author, body) in enumerate(COMMENTS):
            comment = Comment.objects.create(task=tasks_by_title[task_title], author=users[author], body=body)
            Comment.objects.filter(pk=comment.pk).update(created_at=now - timedelta(hours=(len(COMMENTS) - i) * 5))

        codes = {p.code: p for p in Project.objects.all()}
        for title, authors, venue, year, status, code, doi in PUBLICATIONS:
            Publication.objects.create(
                title=title, authors=authors, venue=venue, year=year, status=status, project=codes.get(code), doi=doi
            )

        # A believable activity feed, newest first.
        feed = [
            ("rahul", "moved to In review", "REST endpoint: /cells/{id}/health", "GRID", 1),
            ("kiran", "commented on", "Fix timezone bug in daily totals", "CAMPUS", 3),
            ("arjun", "moved to In review", "Verifier contract gas benchmarks", "ZKRWA", 6),
            ("sneha", "moved to In progress", "Solar vs grid stacked chart", "CAMPUS", 9),
            ("priya", "marked paper Submitted", "Privacy-Preserving Eligibility Proofs for Permissioned Security Tokens", "ZKRWA", 20),
            ("meera", "moved to In progress", "Cell health heatmap on dashboard", "GRID", 26),
            ("priya", "created project", "Crop Yield Forecasting", "AGRI", 40),
            ("kiran", "moved to Done", "Clean voltage spikes and missing readings", "GRID", 52),
            ("arjun", "moved to Done", "Meter data schema + migrations", "CAMPUS", 70),
            ("ananya", "updated project", "Lab Website Revamp", "WEB", 96),
        ]
        for username, verb, target, code, hours_ago in feed:
            a = Activity.objects.create(actor=users[username], verb=verb, target=target, project=codes[code])
            Activity.objects.filter(pk=a.pk).update(created_at=now - timedelta(hours=hours_ago))

        self.stdout.write(self.style.SUCCESS(
            f"Loaded {len(users)} people, {Project.objects.count()} projects, {Task.objects.count()} tasks, "
            f"{Publication.objects.count()} publications. Demo password: {DEMO_PASSWORD}"
        ))
