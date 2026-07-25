from django.urls import path

from apps.core import views

urlpatterns = [
    path("feedback", views.FeedbackView.as_view(), name="api-feedback"),
    path("metrics", views.product_metrics, name="api-product-metrics"),
]
