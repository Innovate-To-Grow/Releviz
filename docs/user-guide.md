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

Open the **Blocked times** step under the Time Table calendar: while it is open, the calendar
itself is the paint surface. Mark the parts of each day that are never available (a lunch break on
Mondays, a late start on Fridays) with the **Blocked** or **Open** brush, by clicking, dragging, or
Enter/Space from the keyboard, and save; the brush and Save sit in a bar under the calendar that
stays on screen while you paint. A mark on a weekday applies to that weekday in every week. Every
day then gets its own usable window within the event's shared start, end, and days.

Blocked slots stay visible in the schedule grid but are greyed out and cannot be painted by
participants. They count as 0 in the results, are never recommended, and cannot be finalized into.
You can change blocked times at any time without resetting responses; after finalization,
reactivate the event first.

## Participants

The **Participants** section of the organizer workspace is one list: each person on one row with
their name, a contact line, their groups, a **Response** badge (**Submitted** or **Not
submitted**), and an **Invitation** badge. The line under the heading counts people, submitted
and not submitted responses, and groups. Adding people and sending invitations are separate
steps, and nobody is emailed until you have seen the email and confirmed it: **Add and send
invitation**, **Review and send invitations** at the end of an import, **Send invitation…** (in
the selection bar or a row's **⋯** menu), and the **Email** menu all open the email review (see
[Review before sending](#review-before-sending)). Closed, finalized, and archived events show the
list read-only until they are reactivated.

Above the list, the search box matches names, emails, phones, and groups; **Group:** narrows the
list to one group (or **No group**); and **Filter** narrows it by response, invitation state, or
whether the person counts in the results. Active filters show as chips with **Clear all**, and
the counts line then reads **Showing n of N people**.

Once an active event's response deadline has passed, a banner says so: people can't be added,
invited, or changed, and your own schedule is locked, but you can still enter schedules for the
people you answer for. **Change deadline** opens the event settings in the Overview with **Advanced
options** expanded and the **Response Deadline** field ready to edit.

### Add people

**+ Add person** opens a side panel with **Full name**, **Email**, and an optional **Phone**
(never used to contact anyone). Two actions save it:

- **Add** (or pressing Enter) puts the person on the list without sending email. The panel stays
  open with a result line and an **Open** link, so several people can be entered one after
  another; **Done** closes it.
- **Add and send invitation** adds the person the same way, then opens the review of their
  invitation above the panel. The invitation goes out only once you confirm it, and the result
  line then says it is queued. Closing the review leaves the person on the list without an
  invitation, and the result line offers **Send invitation** for later.

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
  can invite. After saving a new address, the notice offers **Send invitation** for it.
- **Groups**: the person's group chips and **+ Add to group**, which opens the group picker.
- **In the results**: whether their answers are counted (**Count Ada's answers**, for someone
  called Ada) and their **Weight** (0 to 1).
- **Invitation**: the current state with **Send invitation** or **Resend**, which open the email
  review.

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
   list** (rebuild) and click **Import N people** (or **Replace the list with N people**).
   - Merging adds or updates people and keeps existing schedules and delivery history. A row's
     groups are added to the person's existing groups; an import never removes anyone from a
     group.
   - Rebuilding destructively replaces the participant list, schedules, invitations, temporary
     sessions, and pending deliveries, and everyone starts as **Not sent**. You must type the
     event code to confirm.
4. **Done**: what was imported, ending with **No invitations were sent.** When the import put
   people on the list who can be invited (those a merge added, or everyone a rebuild imported),
   **Review and send invitations (N)…** closes the sheet and opens the invitation review for
   exactly those people. **Back to participants** returns to the list without inviting anyone,
   and **Import another list** starts over.

An import never emails anyone itself. People already on the participant list are not offered an
invitation after a merge, and people without an email of their own and your own row are never
emailed at all.

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

### Review before sending

Every email you send to participants opens the same two-step dialog first: invitations,
reminders, the confirmation sent when you finalize a meeting, the cancellation sent when you
reopen a finalized event, and failed emails sent again. Nothing is sent until you have passed
both steps, and closing the dialog at either step (**Cancel**, **×**, or Escape) sends nothing.
Sign-in codes and other account emails are sent without it.

1. **Review** says who gets the email and shows it exactly as the first of them receives it: the
   **From**, **To**, **Subject**, and **Attachments** (such as the calendar file) lines, then the
   email itself on the **Email** tab and its plain-text version on the **Plain text** tab. A note
   under the envelope names the person it is shown for, for example **Shown for Ada Lovelace.
   Each person gets their own private link.** In the preview that private link is a stand-in
   ending in `invitation=preview`, so it never shows anyone's real link. **Continue** is
   unavailable while the preview loads or when nobody would be emailed.
2. **Confirm** asks once more, for example **Send 3 invitations now?**, with the subject and the
   number of recipients. **Back** returns to the review, and the send button (**Send 3
   invitations**) sends. Emails go out right away and can't be recalled. If sending fails, the
   dialog stays on this step with the error, so you can try again or go back.

### Send invitations

Invitations go to a selection or to everyone still uninvited:

- Tick people in the list (the header checkbox selects the page, and **Select all N matching**
  extends that to everyone matching the filter), then click **Send invitation…** in the selection
  bar. One person's **⋯** menu has **Send invitation** or **Resend invitation** too.
- The **Email** menu offers **Invite everyone not invited yet (N)…**.
- **Add and send invitation** in the add panel, and **Review and send invitations (N)…** at the
  end of an import, invite the people just added.

Each of these opens the [review](#review-before-sending). It says who gets an invitation now, who
was already invited (tick **Email them again too** to include them; a resend keeps any custom
message), who has no email of their own, and who is being emailed right now, above the invitation
the first of them gets. **Send N invitations** on the confirmation step sends them. Sending
returns as soon as the invitation jobs are queued: a notice counts what was queued and skipped,
with **View progress**, and the delivery card at the top of the workspace follows the run.

The **Invitation** badge on each row, which **Filter** also uses, shows:

- **Not sent**: no email yet. These people get no reminders until they are invited.
- **Sending…**: the email is queued or being handed to the provider.
- **Failed**: the provider refused the email for good. The delivery card's **Show failed** filters
  the list to these people. **Retry failed recipients** opens the review with how many failed
  emails will be sent again and the first of them exactly as it was written; failed emails the
  event has moved past (to someone since removed, for a meeting time since changed, or for an
  event no longer active) are canceled instead. **Send N again** on the confirmation step queues
  them.
- **Sent**: emailed, including opened.
- **Accepted**: the person verified their link, joined, or saved or submitted their own response
  after the email. A response you enter for them does not count.
- **No email**: a person without an email of their own; **—** marks your own row.

The delivery card counts recipients that are sent, queued, or failed. It keeps itself current
while recipients are queued (only while the tab is visible), stops once everyone is sent or
failed, and can then be dismissed.

### Reminders

**Send reminders (N)…** in the **Email** menu emails everyone who was invited and has not
submitted. It opens the [review](#review-before-sending) with how many get a reminder, how many
were already reminded for this deadline and are skipped, and the reminder the first of them gets;
**Send N reminders** on the confirmation step sends them. People never invited, people without an
email, and you are skipped, as is anyone already reminded since the deadline was set. A response
you submitted for someone counts as submitted. The menu also says when the next automatic
reminder goes out (**Next automatic reminder: date**) or that **Reminders are off**. While
reminders are turned off in the event settings, **Send reminders** is unavailable too. Automatic
reminders go out on their schedule without a review.

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
sections, **Overview**, **Time Table**, and **Participants**; finalizing is a step inside the Time
Table.

### Event status

An event is **active**, **closed**, **finalized**, or **archived**, and the line at the top of the
page says which in plain words, next to the buttons that change it:

- **Close responses** stops people from submitting or changing schedules and makes the participant
  list read-only. You can still pick and finalize a time. Invitation and reminder emails still
  waiting to go out are canceled and automatic reminders stop.
- **Archive event** (from an active, closed, or finalized event) makes the event read-only and
  moves it to **Archived** on your dashboard. An archived event that had a confirmed meeting keeps
  it, and nobody is emailed until you reactivate the event.
- **Reactivate event** opens a closed, finalized, or archived event again. Reopening one with a
  confirmed meeting cancels the meeting and emails the people the confirmation reached, after you
  have reviewed that email (see [Time Table and finalizing](#time-table-and-finalizing)).

Closing and archiving ask for confirmation first and say what they do; nobody is emailed about
either. The **Archive** button on the account dashboard asks the same question. When an active
event's response deadline passes, the line says people can no longer respond and offers **Change
deadline**, which opens the event settings in the Overview with **Advanced options** expanded and
the **Response Deadline** field ready to edit; the same button is on the Participants banner. An
active event needs a deadline in the future or none, so reactivating an event whose deadline has
passed removes it, says so, and offers **Set a new deadline**.

### Editing the event

**Edit event** in the Overview opens the event settings in place. The **Response Deadline** is
entered in the event's timezone, which the field says. Changing the days, time window, slot length,
or timezone gives everyone a fresh schedule for the new grid, because their old marks no longer
line up. Invitations and membership stay. If anyone has submitted or painted availability, the
editor first asks you to confirm **Schedule changes require a response reset** and says how many
people will lose theirs; people who have only joined or left the starting schedule untouched are not
counted, and when nobody has answered anything the change saves straight away. Every other setting
(name, location, meeting type, duration, access, deadline, reminders) saves without touching
anyone's answers.

### Participants and schedules

- Search and filter the participant list (50 rows per page by default, up to 100).
- Enter, save, or submit anyone's schedule with **Edit schedule** (on the row or in the person
  panel) while the event is active. For people without an email and temporary people this is
  always possible. For someone with a full account, it is possible until they respond themselves
  (join, save or submit their own response, or upgrade a temporary identity to a full account);
  after that the row shows **Answers themselves** and only they can change their answers.
  Conflicting edits are never silently overwritten: the editor asks you to reload the latest
  response. Saving a submitted response as a draft asks first, since it leaves the results until
  it is submitted again. Someone who is left out of the results keeps an editable schedule, which
  counts once you **Count them again**.

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
everyone again**. Leaving someone out changes only the results: they can still save and submit
their schedule, and it counts as soon as they are counted again.

- One person: **Leave out of results** or **Count in results** in the **⋯** menu, or the **In the
  results** section of their panel.
- A selection: **More** in the selection bar offers **Set weight…**, **Count in results**, and
  **Leave out of results**. A change to more than a page of people, or to everyone matching the
  filter, is confirmed first.
- A group: the **Groups** panel's **Weight** field and **Counted** box apply to everyone in the
  group. **Count only this group…** leaves everyone else out without touching weights, to show
  that group's best times; **Count everyone again** brings everyone back.
- People in several groups follow the most recent change.

### Time Table and finalizing

The Time Table shows the meeting-time calendar, with two collapsible steps under it, both closed by
default: **Blocked times** (see above) and **Finalize**. Picking a time on the calendar opens
Finalize. Inside Finalize:

- **Recommended times** lists the recommended windows of the meeting's length as chips. The calendar
  outlines them only while the list is open, and pointing at a chip highlights its time.
- **Other times** picks any open time, recommended or not: choose a day (weekly events offer the
  next four weeks, a week at a time), then click one of its start times, shown with the lowest
  slot's share and the rank when the time is also recommended.

While either list is open and in view, the calendar stays pinned under the section nav (on screens
with room for it, with a shorter grid; scrolled past the lists, it goes with the page). Opening
Other times or browsing its days takes the calendar to that day and highlights its column, and the
time under the pointer or focus is drawn on the calendar before it is picked.

Recommended times are ranked by weighted availability, then unweighted availability, then the
number of fully available people, then time order. For a window spanning several slots, each
person's score is their lowest availability in that window. The weighted score is
`sum(person_score * weight) / sum(positive weights)` over included people who have submitted; people
with weight zero still count toward the unweighted score. There are no required participants.

The list is as long as the good options are, at most ten: a window is listed only if someone with a
weight above 0 can attend all of it, it scores at least half of the best window, and it shares no
slot with a better listed window in the same format (so a long free stretch tiles into separate
hours). The list says why it ends where it does, and an empty list names the reason (no responses
yet, nobody free for a whole window, no upcoming times). Results cached under an older ranking rule
are recomputed on the next read.

On the meeting-time calendar, blocked times are hatched, show no percentage, and cannot be picked.
An open slot whose meeting window would run into a blocked time shows its percentage but cannot
start a meeting. Until at least one response is counted the calendar is not shaded at all (a wall of
0% would read as "nobody is free" when nobody has answered), and says so under the calendar; any
window can still be picked, and its summary says that no responses have been counted yet.

**Finalize** fixes one continuous meeting time, emails an iCalendar invitation to participants, and
offers the calendar file for download. As soon as a window is picked, Finalize counts who could
attend it (available, partial, unavailable, unanswered and left out of the results) and lists each
person below the counts: **Fully available**, **Available if needed** (free for all of it, but only
if needed somewhere), **Available for part of it**, or **Not available** for people who answered,
and **Not submitted** or the reason someone was left out for the rest. It says when that reading is
current and reads it again whenever the results change; **Finalize meeting** waits for it, and a
failed reading offers **Try again**. The **Location or meeting link** you type stays put while you
compare other times.

Then click **Finalize meeting**: it asks what the confirmation would say for the meeting as it
stands, location included, and the [review](#review-before-sending) counts the invited people who
will receive the confirmation and shows the one the first of them gets, for the picked time and with
its calendar file attached. Nothing is finalized until **Finalize and send N emails** on the
confirmation step, and it finalizes exactly the meeting that was reviewed. Only people who were sent
an invitation get the confirmation; when nobody was, the review says no confirmation emails will be
sent, and **Finalize meeting** on the confirmation step finalizes without emailing anyone. Once a
meeting is finalized, picking is locked until the event is reactivated: Finalize shows the confirmed
meeting without the two lists, and the calendar draws the confirmed meeting alone and ignores
clicks.

Reactivating a finalized event (**Reactivate event**) cancels the meeting and emails a matching
cancellation to everyone the confirmation reached. That email is reviewed first in the same way,
and the event reopens only with **Reopen and send N emails**. When nobody received the
confirmation, it reopens at once.

While new responses are being processed, the Time Table says it is updating and keeps showing the
last calculated results; the notice goes away by itself once they are current. A calculation that
fails is retried automatically, and the last calculated results stay on screen meanwhile.

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
