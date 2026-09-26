# User guide

How organizers and participants use Releviz, from creating an event to finalizing a meeting.

- [Create an event](#create-an-event)
- [Participants](#participants)
- [Fill in availability](#fill-in-availability)
- [Organizer dashboard](#organizer-dashboard)

## Create an event

Sign in first, with either an emailed 6-digit code (which creates your account on first use) or an
email and password (set one through **Forgot password** at `/recover`). Then fill out the event form
on the home page:

- **Event Name**: the meeting title
- **Meeting Type**: In-Person (requires a location), Virtual, or Mixed
- **Time Range**: 15- or 30-minute slots; an end time earlier than the start makes an overnight
  window
- **Meeting Duration**: 15–480 minutes, a multiple of the slot size and within one time group
- **Days**: which days of the week are options (Mon–Fri by default)
- **Access**: Invite only (default) or Open link
- **Participants start as**: Available (default; people mark the times that do not work) or Busy
  (people mark the times that work)

New events are active immediately and accept responses as soon as participants join. Creating an
event does not send any email.

### Blocked times

The organizer workspace opens on the **Blocked times** editor right after the event is created.
Paint the parts of each day that are never available (a lunch break on Mondays, a late start on
Fridays) and save. Every day then gets its own usable window within the event's shared start, end,
and days.

Blocked slots stay visible in the schedule grid but are greyed out and cannot be painted. They
count as 0 in the results, never appear in ranked windows, and cannot be finalized into. You can
change blocked times at any time from the Overview panel without resetting responses; after
finalization, reactivate the event first.

## Participants

Adding people and sending invitations are separate steps. Only three actions send invitations:
**Add and send invitation**, an import committed with **Send invitations to newly added people**
ticked, and **Send invitation**. Closed, finalized, and archived events must be reactivated before
their participants can change.

### Add people

**Add person** opens a form with two actions:

- **Add only** puts the person on the participant list without sending email (pressing Enter does
  the same).
- **Add and send invitation** also emails their secure link right away.

If the email already belongs to a Releviz account, that account is added. Until the person responds
themselves, you can still enter their schedule with **Edit schedule**.

**Add myself** puts you, the organizer, on your own participant list under your account's name and
address, and opens your schedule. Your row reads **You (organizer)**, and **Edit my schedule**
enters or changes your answers, which count in the results like everyone else's. You are never sent
an invitation, reminder, or final notification for your own row.

### People without an email

To add someone who has no email of their own, open **Add person**, enter their name and an optional
phone number, tick **No email of their own — use one of mine and I'll enter their schedule**, and
click **Add person**. Leave the email blank to file them under your account's primary verified
address, or type another of your verified addresses.

These people are **Organizer-managed**: they never sign in or receive links, no invitation,
reminder, or final notification is sent for them, and you enter their availability with **Edit
schedule**. Several people can share your address and are told apart by name, so give different
people distinct names (for example "John Smith (Team B)"). Entering an identical name again returns
the existing row.

Typing one of your own addresses into **Add person** without ticking the box is refused, with a
hint pointing to the checkbox or to **Add myself**.

### Edit or remove people

**Edit details** fixes a name or email entered by mistake:

- A name can be changed for anyone whose schedule you still enter. A person who answers under their
  own account keeps their account's name.
- An email can be changed only until the person has signed in with their link, joined, or answered.
  The row moves to the account behind the new address (or a new temporary identity) and keeps its
  name, groups, weight, and any schedule you entered. It gets a fresh invitation marked **Not
  sent**; the old link stops working and any queued email to the old address is canceled.
- Adding an email to an organizer-managed person makes them an ordinary person you can invite.

**Remove** asks for confirmation, then deletes the person along with their schedule, group
memberships, and invitation (a link already sent stops working). It waits if an email to them is
being handed to the provider at that moment. To keep someone's answers but leave them out of the
results, untick **Included** instead.

### Import participants

**Import participants** accepts `.xlsx`, `.csv`, or pasted CSV/TSV.

1. Map the required `name` and `email` columns and the optional `group`, `weight`, `included`, and
   `phone` columns. Columns are matched by header, singular or plural (`Group`, `Groups`, `Team`,
   `Teams`, `Emails`, ...), so check the mapping. A field with no column uses the **Defaults**
   shown below the mapping, for example **No column (weight 1)**.
2. Preview and correct the rows.
3. Commit as **Merge** or **Rebuild**:
   - **Merge** adds or updates people and keeps existing schedules and delivery history. A row's
     groups are added to the person's existing groups; an import never removes anyone from a group.
   - **Rebuild** destructively replaces the participant list, schedules, invitations, temporary
     sessions, and pending deliveries. You must type the event code to confirm.

Tick **Send invitations to newly added people** before committing to email everyone the import adds
(on a rebuild, everyone). Leave it unticked to add them as **Not sent** and invite them later.
People already on the participant list are never emailed again by an import.

Column rules:

- **group**: blank means unassigned, and `ALL` means every group, including groups created later.
  Separate several groups with `;` or `,` (for example `Faculty; Team 3`), so group names cannot
  contain either character.
- **email**: a blank email, or one of your own addresses, adds an organizer-managed person (see
  above), matched by name so re-importing the sheet updates them instead of adding duplicates. The
  preview marks these rows. A blank email needs a verified address on your account to file it under.
- **phone** (also `phone number`, `mobile`, `cell`, or `telephone`): digits, spaces, and
  `+ - ( ) .`, with at least 7 digits and at most 32 characters. Phones are shown and editable in
  the participant table; Releviz never uses them to send anything.

Two rows for the same person (the same email, or the same name without an email) are combined when
they are identical or differ only in their groups; the combined row gets all of those groups.
Otherwise they are flagged as a conflicting duplicate.

### Send invitations

Check people in the participant table and click **Send invitation** (above or below the table). It
skips anyone already sent or still queued, unless **Resend to people already invited** is ticked; a
resend keeps any custom message.

The **Invitation** badge on each row, which **Filter by invitation** also uses, shows:

- **Not sent**: no email yet. These people get no reminders until they are invited.
- **Sent**: emailed, including opened.
- **Accepted**: the person verified their link, joined, or saved or submitted their own response
  after the email. A response you enter for them does not count.

Reminders skip anyone whose response is submitted, including a response you submitted for them.

Sending returns as soon as the invitation jobs are queued. A delivery progress card at the top of
the organizer workspace counts recipients that are sent, queued, or failed, and offers **Retry
failed recipients**. The card keeps itself current while recipients are queued (only while the tab
is visible) and stops once everyone is sent or failed.

### Who can open an event

Invite-only events are visible only to the organizer, existing participants, invited people using
their emailed link, and signed-in accounts whose verified email matches an invitation. Open-link
events let anyone join with the event code, up to the 1,000-person limit.

## Fill in availability

Each participant:

1. Signs in and clicks **Join as** (the button shows their display name).
2. Chooses **Busy**, **If needed**, or **Available** (scored 0, 0.5, and 1).
3. Paints slots on the **schedule grid** by clicking, dragging, touching, or using the keyboard.
4. Clicks **Submit Availability** when done.

If the organizer already added them, they skip **Join as** and see any schedule the organizer
entered. Their first save or submit makes the response theirs.

By default every slot starts **Available**, so participants paint **Busy** over the times that do
not work. The brush starts on the opposite of the starting state, and **Mark all Available** resets
the grid. If the organizer sets **Participants start as** to Busy, slots start empty, the brush
starts on Available, and **Mark all Busy** is the reset. Changing this setting on an existing event
re-seeds only the schedules of people who have not touched theirs yet.

The grid uses color and text cues: hatched red (busy), yellow ◐ (if needed), and green ✓
(available). Virtual meetings use red, purple, and blue. Grey striped cells are blocked times: they
cannot be painted, **Apply to all** skips them, and anything marked there before the block was added
is ignored.

Participants only ever see their own schedule; group availability is visible to the organizer only.

## Organizer dashboard

Open the organizer view from the account that created the event. It is one page with three
sections, **Overview**, **Results**, and **Participants**; finalizing is a step inside Results.

### Participants and schedules

- Search and filter the participant list (50 rows per page by default, up to 100).
- Enter, save, or submit anyone's schedule with **Edit schedule** while the event is active. For
  organizer-managed and temporary people this is always possible. For someone with a full account,
  it is possible until they respond themselves (join, save or submit their own response, or upgrade
  a temporary identity to a full account); after that the row shows **Self-managed** and only they
  can change their answers. Conflicting edits are never silently overwritten.

### Groups

Create groups from the Groups panel, even before anyone is on the participant list. The participant
table has an **All** column and one checkbox column per group:

- Tick a person's box in a group column to add them to that group; one person can be in several
  groups.
- Tick **All** to put them in every group, including groups created later.
- Ticks are a draft until you click **Save group changes** (or **Discard**). A bar at the bottom of
  the screen counts unsaved changes, and leaving the page with unsaved changes asks first.

The Groups panel can also add or remove everyone checked in the list at once. **Delete group** asks
for confirmation; the group's people stay on the participant list.

### Weights and inclusion

- Change weights and the **Included** flag for a group, the current filter, or a selection, then
  override individuals as needed.
- A group's **Included** box includes or leaves out everyone in it (it shows a mixed state when only
  some are included).
- **Only this group** includes that group and leaves everyone else out, without touching weights, to
  show that group's best times. **Include everyone** brings everyone back.
- People in several groups follow the most recent change.

### Results and finalizing

The Results section shows the top ten candidate windows of the meeting's length, ranked by weighted
availability, then unweighted availability, then the number of fully available people, then time
order. For a window spanning several slots, each person's score is their lowest availability in that
window. The weighted score is `sum(person_score * weight) / sum(positive weights)` over included
people who have submitted; people with weight zero still count toward the unweighted score. There
are no required participants.

On the meeting-time calendar, blocked times are hatched, show no percentage, and cannot be picked.
An open slot whose meeting window would run into a blocked time shows its percentage but cannot
start a meeting.

**Finalize** fixes one continuous meeting time, emails an iCalendar invitation to participants, and
offers the calendar file for download. Reactivating a finalized event emails a matching
cancellation.

While new responses are being processed, Results says it is updating and keeps showing the last
completed results; once current, it shows when they were generated.

### Live updates

The workspace updates itself; there is no Refresh button. While the tab is visible it holds one
event stream open (`GET /events/stream`, Server-Sent Events), and the server announces every change
to the event: a participant saving, an email being sent, results being recomputed, or an edit made
in another session. Each announcement arrives well under a second after the change and reloads just
the parts of the workspace that changed, without disturbing a selected time, an unsaved row, or an
open drawer. A check once a minute remains as a safety net, and a check that fails is retried within
seconds.

When the stream is unavailable (local development on SQLite, a proxy that buffers responses, or the
`LIVE_STREAM_ENABLED=0` switch) the workspace falls back to checking on its own. While the event is
active it checks about every 3 seconds while things are changing and slows to every 15 seconds when
idle. While the event is closed, finalized, or archived it checks every 15 seconds, slowing to once
a minute, which is enough to notice a reactivation made elsewhere. Either way it checks immediately
when you return to the tab, the window regains focus, or you reconnect. While the event is active
the header shows a **Live** badge with the last update time, or **Live updates paused** with the
reason if a check fails; checking continues on its own.
