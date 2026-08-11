from django.core.exceptions import PermissionDenied
from django.http import HttpResponse, HttpResponseRedirect
from django.shortcuts import render
from django.urls import reverse

from .forms import MemberImportForm


def get_primary_email_display(member):
    return member.get_primary_email() or "-"


def get_primary_phone_display(member):
    return member.get_primary_phone() or "-"


def get_full_name_display(member):
    return member.get_full_name() or "-"


def normalize_inline_uuid_none_values(request):
    if request.method != "POST":
        return

    inline_prefixes = ("contact_emails-", "contact_phones-")
    uuid_suffixes = ("-id", "-member")
    post_data = request.POST
    original_mutable = getattr(post_data, "_mutable", None)
    if original_mutable is not None:
        post_data._mutable = True
    try:
        for key, values in list(post_data.lists()):
            if not key.startswith(inline_prefixes) or not key.endswith(uuid_suffixes):
                continue
            normalized_values = ["" if value == "None" else value for value in values]
            if normalized_values != values:
                post_data.setlist(key, normalized_values)
    finally:
        if original_mutable is not None:
            post_data._mutable = original_mutable


def activate_members(admin_obj, request, queryset):
    updated = queryset.update(is_active=True)
    admin_obj.message_user(request, f"{updated} member(s) activated.")


def deactivate_members(admin_obj, request, queryset):
    updated = queryset.update(is_active=False)
    admin_obj.message_user(request, f"{updated} member(s) deactivated.")


def build_excel_response(content, filename):
    response = HttpResponse(content, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


def export_members_response(queryset):
    from django.utils import timezone

    from ...services.members.export_excel import export_members_to_excel

    content = export_members_to_excel(queryset)
    filename = f"members_export_{timezone.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return build_excel_response(content, filename)


def build_vcard_response(content, filename):
    response = HttpResponse(content, content_type="text/vcard; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


def export_members_vcard_response(queryset):
    from django.utils import timezone

    from ...services.members.export_vcf import export_members_to_vcard

    content = export_members_to_vcard(queryset)
    filename = f"members_export_{timezone.now().strftime('%Y%m%d_%H%M%S')}.vcf"
    return build_vcard_response(content, filename)


def import_excel_view(admin_obj, request):
    from ...services.members.import_ import import_members_from_excel

    # ``admin_view`` only enforces is_staff, so this custom URL must re-check
    # per-app access itself — otherwise a staff member without the authn app
    # could create members here. Updating existing members is additionally
    # gated below.
    if not admin_obj.has_view_permission(request):
        raise PermissionDenied("You do not have permission to import members.")

    context = build_import_context(admin_obj, request, MemberImportForm(), result=None)
    if request.method != "POST":
        return render(request, "admin/authn/member/import_excel.html", context)

    form = MemberImportForm(request.POST, request.FILES)
    context["form"] = form
    if form.is_valid():
        update_existing = form.cleaned_data.get("update_existing", False)
        if update_existing and not admin_obj.has_change_permission(request):
            raise PermissionDenied("You do not have permission to update existing members.")

        result = import_members_from_excel(
            file=form.cleaned_data["excel_file"],
            default_password=form.cleaned_data.get("set_password") or None,
            update_existing=update_existing,
            update_member_allowed=(
                (lambda member: admin_obj.has_change_permission(request, member)) if update_existing else None
            ),
        )
        context["result"] = result
        if result.success:
            message = (
                f"Import complete: {result.created_count} created, "
                f"{result.updated_count} updated, "
                f"{result.skipped_count} skipped"
            )
            if result.errors:
                message += f", {len(result.errors)} error(s)"
            admin_obj.message_user(request, message, level="success" if not result.errors else "warning")

    return render(request, "admin/authn/member/import_excel.html", context)


def download_template_view(admin_obj, request):
    from ...services.members.import_ import generate_template_excel

    if not admin_obj.has_view_permission(request):
        raise PermissionDenied("You do not have permission to access member tooling.")

    try:
        content = generate_template_excel()
        return build_excel_response(content, "member_import_template.xlsx")
    except ImportError as exc:
        admin_obj.message_user(request, str(exc), level="error")
        return HttpResponseRedirect(reverse("admin:authn_member_changelist"))


def export_excel_view(admin_obj, request):
    # Member records are PII; ``admin_view`` only checks is_staff, so re-check
    # per-app access before exporting the whole member list.
    if not admin_obj.has_view_permission(request):
        raise PermissionDenied("You do not have permission to export members.")
    return export_members_response(admin_obj.get_queryset(request))


def build_import_context(admin_obj, request, form, result):
    return {
        **admin_obj.admin_site.each_context(request),
        "title": "Import Members",
        "opts": admin_obj.model._meta,
        "form": form,
        "result": result,
    }
