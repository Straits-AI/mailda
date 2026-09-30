import type { Area } from "../areas.ts";

/**
 * The mail view's list pane (`src/client/app/screens/inbox.tsx`): search, filters, tabs, rows, the count, the
 * empty states and the acts on a message. The reading pane's own words are `reader.tsx`'s (layer 2a).
 *
 * The places' names are not here: the Inbox, Archive and Trash headings and chips read `route./`,
 * `route./archive` and `route./trash`, which the glossary binds.
 */
export const inbox = {
  // Moving between places, and the Undo that moves it back.
  "inbox.moved.inbox": "Moved to Inbox.",
  "inbox.moved.archive": "Archived.",
  "inbox.moved.trash": "Moved to Trash.",
  "inbox.movedBack.inbox": "Moved back to Inbox.",
  "inbox.movedBack.archive": "Moved back to Archive.",
  "inbox.movedBack.trash": "Moved back to Trash.",
  "inbox.alreadyArchived": "Already in Archive.",
  "inbox.undo": "Undo",

  // Search (#107).
  "inbox.search.label": "Search mail",
  "inbox.search.submit": "Search",
  "inbox.search.clear": "Clear search",
  "inbox.search.found": {
    one: "Searched senders, subjects and text in all mail, including Archive and Trash · {n} match",
    other: "Searched senders, subjects and text in all mail, including Archive and Trash · {n} matches",
  },
  "inbox.search.capped": "Best {n} matches — narrow the words to see others",
  "inbox.search.none":
    "No mail matches those words. Every word has to appear, and it has to appear in the same place — a word from a subject and a word from a message's text will not match together. Message text is searched only in mailboxes where you can read content; elsewhere only subjects and senders are searched.",
  "inbox.search.noneInMailbox":
    "No mail matches those words in this mailbox. Every word has to appear, and it has to appear in the same place — a word from a subject and a word from a message's text will not match together. Message text is searched only in mailboxes where you can read content; elsewhere only subjects and senders are searched.",

  // What the status region says when a search or a filter answers (WCAG 4.1.3).
  "inbox.heard.none": "No mail matches those words.",
  "inbox.heard.capped": "Best {n} matches.",
  "inbox.heard.found": { one: "{n} match.", other: "{n} matches." },
  "inbox.heard.page": "Page {page} of the mail that matches these filters.",
  "inbox.heard.exact": { one: "{n} message matches these filters.", other: "{n} messages match these filters." },
  "inbox.heard.more": "{n}+ messages match these filters.",

  // The count beside the heading (#91): never a total nothing counted.
  "inbox.count.page": "Page {page}",
  "inbox.count.more": "{n}+",
  "inbox.count.noun": { one: "message", other: "messages" },
  "inbox.count.nounMore": "messages",

  // The Filter control.
  "inbox.filter.label": "Filter",
  "inbox.filter.active": "Filter, {n} active",
  "inbox.filter.mailbox": "Mailbox",
  "inbox.filter.allMailboxes": "All mailboxes",
  "inbox.filter.sender": "Sender address",
  "inbox.filter.senderHint": "The address the sending server gave; it can differ from the From line on forwarded mail.",
  "inbox.filter.since": "Received on or after",
  "inbox.filter.until": "Received on or before",
  "inbox.filter.apply": "Apply",
  "inbox.filter.clear": "Clear",
  "inbox.filter.clearAll": "Clear filters",
  "inbox.chip.mailbox": "Mailbox: {mailbox}",
  "inbox.chip.from": "From: {address}",
  "inbox.chip.since": "On or after {day}",
  "inbox.chip.until": "On or before {day}",
  "inbox.chip.remove": "Remove filter: {filter}",
  /** Stands in for a mailbox's name before the mailbox lists have answered. */
  "inbox.thisMailbox": "this mailbox",

  // The tabs. "Mine" is also the row chip: the same word as the API's `mine`.
  "inbox.tabs": "Inbox views",
  "inbox.tab.all": "All",
  "inbox.tab.unread": "Unread",
  "inbox.tab.mine": "Mine",
  "inbox.tab.mineTitle": "Cases you hold",

  // A row and its chips.
  "inbox.row.unread": "Unread, ",
  "inbox.chip.dmarcFail": "DMARC fail",
  "inbox.chip.held": "Held",

  // The label and Trash lines of the status line.
  "inbox.label.showing": "Showing mail labelled {label}.",
  "inbox.label.showAll": "Show all",
  "inbox.trash.note": "Trash keeps messages until you move them back. Nothing here is deleted.",

  // Acts on the open message: the shortcuts' descriptions and the palette's commands.
  "inbox.act.reply": "Reply",
  "inbox.act.replyAll": "Reply all",
  "inbox.act.forward": "Forward",
  "inbox.act.archive": "Archive",
  "inbox.act.trash": "Move to Trash",
  "inbox.act.unread": "Mark unread",
  "inbox.act.read": "Mark read",
  "inbox.act.next": "Next message",
  "inbox.act.previous": "Previous message",

  // Why an act did not go ahead (R6), and what it did.
  "inbox.unreachable": "This Node could not be reached ({problem}).",
  "inbox.blocked.toast": "{subject}: {problem}",
  "inbox.takeAnyway": "Take it anyway",
  "inbox.reply.noCase": "This message has no case yet, so it cannot be claimed. It predates the queue.",
  "inbox.reply.noBody":
    "{problem} Without it, who a reply goes to and whom it copies are unknown, so nothing was claimed or opened. Try again.",
  "inbox.forward.unfiled": "This message has not been filed yet, so there is nothing to forward. Try again in a minute.",
  "inbox.claimed": "Claimed.",
  "inbox.released": "Released to the queue.",
  "inbox.withheld.reply": "Replying from {mailbox} needs send.propose on it, which you do not hold.",
  "inbox.withheld.unfiled": "This message has not been filed yet. Try again in a minute.",
  "inbox.withheld.content": "Filing and read state need mailbox.content.read on {mailbox}, which you do not hold.",
  "inbox.withheld.loading": "Still reading which mailboxes you can send from.",

  // The list, the pager and the empty reader.
  "inbox.listPane": "Message list",
  "inbox.list": "Messages",
  "inbox.pages": "Pages",
  "inbox.page.newer": "Newer",
  "inbox.page.newest": "Newest",
  "inbox.page.older": "Older",
  "inbox.reader.none": "No message selected",
  "inbox.reader.keys": "J and K move through the list",

  // What an empty page means: one sentence true of it.
  "inbox.empty.older": "Nothing older on this page.",
  "inbox.empty.filtered": "Nothing matches these filters.",
  "inbox.empty.unread": "Nothing unread in your Inbox.",
  "inbox.empty.mine": "You hold no cases in your Inbox.",
  "inbox.empty.archive": "Nothing archived.",
  "inbox.empty.trash": "Your Trash is empty.",
  "inbox.empty.inbox":
    "No messages are visible in your Inbox. Whether mail can reach this Node is a separate question — Doctor's inbound routing check answers it.",
  "inbox.empty.routing": "Check inbound routing",

  /*
   * A lookback that stopped with nothing found (R26), one whole sentence per case: the page (the newest, or
   * the next older), whether the Node sent its bound, whether filters are on, and the tab.
   */
  "inbox.lookback.further": "Look further back",
  "inbox.lookback.newest.counted.any.all": "None of the newest {n} messages you can see is in your Inbox.",
  "inbox.lookback.newest.counted.any.unread": "None of the newest {n} messages you can see is unread.",
  "inbox.lookback.newest.counted.any.mine": "None of the newest {n} messages you can see is in a case you hold.",
  "inbox.lookback.newest.counted.filtered.all": "None of the newest {n} messages you can see that match these filters is in your Inbox.",
  "inbox.lookback.newest.counted.filtered.unread": "None of the newest {n} messages you can see that match these filters is unread.",
  "inbox.lookback.newest.counted.filtered.mine": "None of the newest {n} messages you can see that match these filters is in a case you hold.",
  "inbox.lookback.newest.uncounted.any.all": "None of the newest messages you can see is in your Inbox.",
  "inbox.lookback.newest.uncounted.any.unread": "None of the newest messages you can see is unread.",
  "inbox.lookback.newest.uncounted.any.mine": "None of the newest messages you can see is in a case you hold.",
  "inbox.lookback.newest.uncounted.filtered.all": "None of the newest messages you can see that match these filters is in your Inbox.",
  "inbox.lookback.newest.uncounted.filtered.unread": "None of the newest messages you can see that match these filters is unread.",
  "inbox.lookback.newest.uncounted.filtered.mine": "None of the newest messages you can see that match these filters is in a case you hold.",
  "inbox.lookback.older.counted.any.all": "None of the next {n} older messages you can see is in your Inbox.",
  "inbox.lookback.older.counted.any.unread": "None of the next {n} older messages you can see is unread.",
  "inbox.lookback.older.counted.any.mine": "None of the next {n} older messages you can see is in a case you hold.",
  "inbox.lookback.older.counted.filtered.all": "None of the next {n} older messages you can see that match these filters is in your Inbox.",
  "inbox.lookback.older.counted.filtered.unread": "None of the next {n} older messages you can see that match these filters is unread.",
  "inbox.lookback.older.counted.filtered.mine": "None of the next {n} older messages you can see that match these filters is in a case you hold.",
  "inbox.lookback.older.uncounted.any.all": "None of the next older messages you can see is in your Inbox.",
  "inbox.lookback.older.uncounted.any.unread": "None of the next older messages you can see is unread.",
  "inbox.lookback.older.uncounted.any.mine": "None of the next older messages you can see is in a case you hold.",
  "inbox.lookback.older.uncounted.filtered.all": "None of the next older messages you can see that match these filters is in your Inbox.",
  "inbox.lookback.older.uncounted.filtered.unread": "None of the next older messages you can see that match these filters is unread.",
  "inbox.lookback.older.uncounted.filtered.mine": "None of the next older messages you can see that match these filters is in a case you hold.",
} as const satisfies Area<"inbox">;
