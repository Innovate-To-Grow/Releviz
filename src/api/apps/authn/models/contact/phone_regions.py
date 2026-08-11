"""
Phone number region/country code choices for contact models.

SMS delivery via AWS SNS in this account is limited to US numbers, so the contact
and event-registration flows only support the United States. The region field is
retained (always "1-US") to drive E.164 reconstruction and display.
"""

# Phone number region/country code choices (US-only)
PHONE_REGION_CHOICES = [
    ("1-US", "United States"),
]
