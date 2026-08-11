class MemberSyncError(RuntimeError):
    """Raised when member sheet sync fails."""


def _get_worksheet(config):
    import apps.authn.services.members.sheet_sync as sync_api

    credentials = sync_api.GoogleCredentialConfig.load()
    if not credentials.is_configured:
        raise MemberSyncError("No active Google service account is configured.")

    import gspread

    client = gspread.service_account_from_dict(credentials.get_credentials_info())
    spreadsheet = client.open_by_key(config.google_sheet_id)

    if config.worksheet_gid is not None:
        worksheet = next(
            (ws for ws in spreadsheet.worksheets() if ws.id == config.worksheet_gid),
            None,
        )
        if worksheet is None:
            raise MemberSyncError("Worksheet GID not found in the spreadsheet.")
    else:
        worksheet = spreadsheet.sheet1

    return worksheet
