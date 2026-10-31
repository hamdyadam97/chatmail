"""URL routes for /api/v1/search/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.SearchView.as_view(), name="search"),
]
