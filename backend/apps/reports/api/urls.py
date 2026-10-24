"""URL routes for /api/v1/reports/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.ReportView.as_view(), name="report"),
    path("export/", views.ReportExportView.as_view(), name="report-export"),
    path("units/", views.ReportUnitsView.as_view(), name="report-units"),
    path("health/", views.HealthView.as_view(), name="report-health"),
]
