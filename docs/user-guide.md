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

The **Participants** section of the organizer workspace is one list: each person on one row with
their name, a contact line, their groups, a **Response** badge (**Submitted** or **Not
submitted**), and an **Invitation** badge. The line under the heading counts people, submitted
and not submitted responses, and groups. Adding people and sending invitations are separate
steps, and nobody is emailed until you invite them: only **Add and send invitation**, an import
with **Email invitations to the people this import adds** ticked, **Send invitation…** (in the
selection bar or a row's **⋯** menu), and the **Email** menu send anything. Closed, finalized, and
archived events show the list read-only until they are reactivated.

Above the list, the search box matches names, emails, phones, and groups; **Group:** narrows the
list to one group (or **No group**); and **Filter** narrows it by response, invitation state, or
whether the person counts in the results. Active filters show as chips with **Clear all**, and
the counts line then reads **Showing n of N people**.

Once an active event's response deadline has passed, a banner says so: people can't be added,
invited, or changed, and your own schedule is locked, but you can still enter schedules for the
people you answer for. **Change deadline** opens the event settings.

### Add people

**+ Add person** opens a side panel with **Full name**, **Email**, and an optional **Phone**
(never used to contact anyone). Two actions save it:

- **Add** (or pressing Enter) puts the person on the list without sending email. The panel stays
  open with a result line and an **Open** link, so several people can be entered one after
  another; **Done** closes it.
- **Add and send invitation** also emails their secure link right away.

If the email already belongs to a Releviz account, that account is added. Until the person
responds themselves, you can still enter their schedule with **Edit schedule**. An email that is
already on the list adds nothing, and the result says so.

**Add myself** (in the empty list, or at the bottom of the add panel) puts you, the organizer, on
your own participant list under your account's name and address, and opens your schedule. Your
row reads **your name (you)** with **From your account**, and **Edit my schedule** enters or
changes your answers, which count in the results like everyone else's. You are never sent an
invitation, reminder, or final notification for your own row.

### People without an email

To add someone who has no email of their own, open **+ Add person**, enter their name and an
optional phone number, and tick **They have no email. I'll enter their schedule.** The email
field goes away and **Add** files them under your account's primary verified address (an import
can use another of your verified addresses).

These people never sign in or receive links, no invitation, reminder, or final notification is
sent for them, and you enter their availability with **Edit schedule** (the add panel offers
**Enter their schedule** straight away). Their row reads **No email · you enter their schedule**,
their invitation badge reads **No email**, and the filing address is never shown. Several people
can share your address and are told apart by name, so give different people distinct names (for
example "John Smith (Team B)"). Entering an identical name again returns the existing row.

Typing one of your own addresses into the add panel without ticking the box is refused, with a
hint pointing to the checkbox or to **Add myself**.

### Edit or remove people

Clicking a person's name (or **Details** in the row's **⋯** menu) opens their panel, with **‹ ›**
arrows to move to the previous or next person on the page. It says how the row is answered
(invited by email, has a Releviz account, answers with their own account, no email of their own,
or your own row), offers **Edit schedule**, and groups everything about the person:

- **Contact**: **Full name**, **Email**, and **Phone**. A name can be changed for anyone whose
  schedule you still enter; a person who answers under their own account keeps their account's
  name. An email can be changed only until the person has signed in with their link, joined, or
  answered. The row then moves to the account behind the new address (or a new temporary
  identity) and keeps its name, groups, weight, and any schedule you entered; it gets a fresh
  invitation marked **Not sent**, the old link stops working, and any queued email to the old
  address is canceled. Adding an email to a person without one makes them an ordinary person you
  can invite.
- **Groups**: the person's group chips and **+ Add to group**, which opens the group picker.
- **In the results**: whether their answers are counted (**Count Ada's answers**, for someone
  called Ada) and their **Weight** (0 to 1).
- **Invitation**: the current state with **Send invitation** or **Resend**.

**Save** sends only what changed, and closing with unsaved edits asks first. If someone else
changed the row in the meantime, the row shows the latest values with **Apply again** and
**Dismiss**.

**Remove from event…** (in the row's **⋯** menu or at the bottom of the person panel) asks for
confirmation, then deletes the person along with their schedule, group memberships, and
invitation (a link already sent stops working). It waits if an email to them is being handed to
the provider at that moment. To keep someone's answers but leave them out of the results, use
**Leave out of results** instead.

### Import participants

**Import** opens a sheet that accepts `.xlsx`, `.csv`, or cells pasted from a spreadsheet, in four
steps:

1. **Source**: **Upload a file** or **Paste from a spreadsheet**, then **Continue**.
2. **Columns**: check which column fills each field. The required **Name** and **Email** columns
   and the optional **Group**, **Phone**, **Weight**, and **Included** columns are matched by
   header, singular or plural (`Group`, `Groups`, `Team`, `Organization`, `Mail`, `Tel`, ...), and
   the sheet shows what the first data row gives each field. A field with no column takes the
   default shown beside it (a default group, weight, and whether people are counted); **change**
   picks another worksheet or header row. **Preview rows** validates the sheet.
3. **Review**: every row with its status (**Ready**, **Needs fixing**, **Merged into row n**, or
   **Skipped**). Fix cells in place, untick rows to skip them, and use **Show** to see only the
   rows that need fixing. Then choose **Add and update people** (merge) or **Replace the whole
   list** (rebuild), tick **Email invitations to the people this import adds** if they should be
   emailed, and click **Import N people** (or **Replace the list with N people**); the button
   adds **and send invitations** when the box is ticked.
   - Merging adds or updates people and keeps existing schedules and delivery history. A row's
     groups are added to the person's existing groups; an import never removes anyone from a
     group.
   - Rebuilding destructively replaces the participant list, schedules, invitations, temporary
     sessions, and pending deliveries. You must type the event code to confirm.
4. **Done**: what was imported and, when invitations were sent, how their delivery is going, with
   **View progress**. **Back to participants** returns to the list, and **Import another list**
   starts over.

People already on the participant list are never emailed again by an import, and people without
an email of their own are never emailed at all.

Column rules:

- **group**: blank means unassigned, and `ALL` means every group, including groups created later.
  Separate several groups with `;` or `,` (for example `Faculty; Team 3`), so group names cannot
  contain either character.
- **email**: a blank email, or one of your own addresses, adds a person without an email of their
  own (see above), matched by name so re-importing the sheet updates them instead of adding
  duplicates. The review step marks these rows. A blank email needs a verified address on your
  account to file it under.
- **phone** (also `phone number`, `mobile`, `cell`, `telephone`, or `tel`): digits, spaces, and
  `+ - ( ) .`, with at least 7 digits and at most 32 characters. Phones are shown and editable in
  the person panel; Releviz never uses them to send anything.

Two rows for the same person (the same email, or the same name without an email) are combined when
they are identical or differ only in their groups; the combined row gets all of those groups.
Otherwise they are flagged as a conflicting duplicate.

### Send invitations

Invitations go to a selection or to everyone still uninvited:

- Tick people in the list (the header checkbox selects the page, and **Select all N matching**
  extends that to everyone matching the filter), then click **Send invitation…** in the selection
  bar. One person's **⋯** menu has **Send invitation** or **Resend invitation** too.
- The **Email** menu offers **Invite everyone not invited yet (N)…**.

Either way a confirmation says who gets an invitation now, who was already invited (tick **Email
them again too** to resend; a resend keeps any custom message), who has no email of their own,
and who is being emailed right now. Sending returns as soon as the invitation jobs are queued: a
notice counts what was queued and skipped, and the delivery card at the top of the workspace
follows the run.

The **Invitation** badge on each row, which **Filter** also uses, shows:

- **Not sent**: no email yet. These people get no reminders until they are invited.
- **Sending…**: the email is queued or being handed to the provider.
- **Failed**: the provider refused the email for good. The delivery card's **Show failed** filters
  the list to these people, and **Retry failed recipients** queues them again.
- **Sent**: emailed, including opened.
- **Accepted**: the person verified their link, joined, or saved or submitted their own response
  after the email. A response you enter for them does not count.
- **No email**: a person without an email of their own; **—** marks your own row.

The delivery card counts recipients that are sent, queued, or failed. It keeps itself current
while recipients are queued (only while the tab is visible), stops once everyone is sent or
failed, and can then be dismissed.

### Reminders

**Send reminders (N)…** in the **Email** menu emails everyone who was invited and has not
submitted, after a confirmation that shows the count. People never invited, people without an
email, and you are skipped, as is anyone already reminded since the deadline was set. A response
you submitted for someone counts as submitted. The menu also says when the next automatic
reminder goes out (**Next automatic reminder: date**) or that **Reminders are off**.

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
- Enter, save, or submit anyone's schedule with **Edit schedule** (on the row or in the person
  panel) while the event is active. For people without an email and temporary people this is
  always possible. For someone with a full account, it is possible until they respond themselves
  (join, save or submit their own response, or upgrade a temporary identity to a full account);
  after that the row shows **Answers themselves** and only they can change their answers.
  Conflicting edits are never silently overwritten: the editor asks you to reload the latest
  response. Saving a submitted response as a draft asks first, since it leaves the results until
  it is submitted again, and someone who is left out of the results has a read-only schedule
  until you **Count them again**.

### Groups

Groups are labels for filtering and for changing many people at once; results use each person's
weight and whether they count. Create one from the **Group:** menu (**+ New group**), inside the
group picker, or in the **Groups** panel (**Manage groups…**), even before anyone is on the list.

- To change one person's groups, open their panel and use **+ Add to group**.
- To change many at once, select them and click **Groups…** in the selection bar. The picker
  shows each group with how many of the selected people are in it: tick a group to add everyone,
  untick it to remove everyone, and leave a mixed box alone to keep things as they are. **Every
  group, including groups added later** puts people in every group, present and future.
- The **Groups** panel lists every group with its head count, shared **Weight** (blank when
  mixed), and how many of its people are **Counted**, plus the people in **No group**. A group's
  menu offers **Select these N people**, **Rename**, **Count only this group…**, and **Delete
  group…** (the group's people stay on the participant list).

### Weights and inclusion

Each person has a weight between 0 and 1 and either counts in the results or is left out. Rows
show **Weight w** when the weight is not 1 and **Left out of results** when the person is not
counted, and a banner above the list counts everyone left out, with **Show them** and **Count
everyone again**.

- One person: **Leave out of results** or **Count in results** in the **⋯** menu, or the **In the
  results** section of their panel.
- A selection: **More** in the selection bar offers **Set weight…**, **Count in results**, and
  **Leave out of results**. A change to more than a page of people, or to everyone matching the
  filter, is confirmed first.
- A group: the **Groups** panel's **Weight** field and **Counted** box apply to everyone in the
  group. **Count only this group…** leaves everyone else out without touching weights, to show
  that group's best times; **Count everyone again** brings everyone back.
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
the parts of the workspace that changed, without disturbing a selected time, a selection, unsaved
edits in a panel, or an open drawer. A check once a minute remains as a safety net, and a check
that fails is retried within seconds.

When the stream is unavailable (local development on SQLite, a proxy that buffers responses, or the
`LIVE_STREAM_ENABLED=0` switch) the workspace falls back to checking on its own. While the event is
active it checks about every 3 seconds while things are changing and slows to every 15 seconds when
idle. While the event is closed, finalized, or archived it checks every 15 seconds, slowing to once
a minute, which is enough to notice a reactivation made elsewhere. Either way it checks immediately
when you return to the tab, the window regains focus, or you reconnect. While the event is active
the header shows a **Live** badge with the last update time, or **Live updates paused** with the
reason if a check fails; checking continues on its own.
