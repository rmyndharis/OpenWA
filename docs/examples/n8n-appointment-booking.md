# n8n Appointment Booking Workflow

This example shows how to use OpenWA and n8n to collect appointment requests over WhatsApp, check availability in an external system, and send a confirmation or alternative time slots.

The workflow is intentionally generic. The availability source can be Google Calendar, Cal.com, a CRM, a database, or any HTTP API that returns available slots.

## Flow

```
[OpenWA Trigger]
      │
      └── Events: message.received
              │
              ▼
[IF: booking intent?]
      │
      ├── false → [OpenWA: Send Text]
      │             "Thanks for your message. A team member will reply soon."
      │
      └── true
              │
              ▼
[Set: normalize request]
              │
              ▼
[Availability Source]
      │
      ├── available → [Create Booking] → [OpenWA: Send Text confirmation]
      │
      └── unavailable → [OpenWA: Send Text with alternative slots]
```

## Trigger

Use the **OpenWA Trigger** node.

| Field | Value |
| ----- | ----- |
| Event | `message.received` |
| Session | Your connected OpenWA session |

The incoming message body is available at:

```text
{{$json.data.body}}
```

The sender chat ID is available at:

```text
{{$json.data.chatId}}
```

## Booking Intent Check

Add an **IF** node after the trigger. For a simple first version, check whether the incoming message contains booking-related words such as appointment, booking, schedule, reserve, cita, or reserva.

For a production workflow, replace this with a classifier, a structured form flow, or your CRM-specific routing rules.

## Normalize the Request

Add a **Set** node to extract the values your booking system expects.

Suggested fields:

| Field | Example value |
| ----- | ------------- |
| `chatId` | `{{$json.data.chatId}}` |
| `phone` | `{{$json.data.from}}` |
| `message` | `{{$json.data.body}}` |
| `requestedDate` | Parsed date from the message or a default fallback |
| `service` | Parsed service name or workflow default |

If the message does not contain enough information, send a clarification question instead of creating a booking.

Example clarification message:

```text
Thanks. What day and time would you prefer for the appointment?
```

## Availability Check

Use whichever node matches your scheduling source:

| Source | n8n node |
| ------ | -------- |
| Google Calendar | Google Calendar or HTTP Request |
| Cal.com | HTTP Request |
| Internal API | HTTP Request |
| Database | PostgreSQL / MySQL / SQLite node |
| Spreadsheet | Google Sheets |

The availability step should return whether the requested slot is available and, if not, a small list of alternatives.

## Confirmation Message

When the requested slot is available, create the booking in your scheduling source and send a confirmation with the **OpenWA: Send Text** node.

| Field | Value |
| ----- | ----- |
| Resource | Message |
| Operation | Send Text |
| Chat ID | `{{$json.chatId}}` |
| Text | Confirmation message |

Example confirmation text:

```text
Your appointment is confirmed for {{$json.slot}}.

Reply CANCEL if you need to cancel or change it.
```

## Alternative Slots Message

When the requested slot is not available, send available alternatives instead of failing silently.

Example text:

```text
That time is not available. These slots are open:

1. {{$json.alternatives[0]}}
2. {{$json.alternatives[1]}}

Reply with 1 or 2 to confirm one of these options.
```

## Operational Notes

- Store booking state outside WhatsApp, for example in your scheduling system, CRM, or database.
- Add an idempotency key based on the incoming `messageId` to avoid duplicate bookings if a workflow is retried.
- Confirm the booking only after the external system accepts the slot.
- Add a fallback path for unsupported messages or missing required fields.
- Respect applicable messaging rules and avoid unsolicited or high-volume messages.

## Minimal Node Checklist

- OpenWA Trigger: receives `message.received` events.
- IF: detects booking intent.
- Set: normalizes `chatId`, message body, requested date/time, and service.
- Availability node: checks the calendar, API, database, or spreadsheet.
- Booking node: creates the appointment only when a slot is available.
- OpenWA Send Text: sends confirmation, alternatives, or clarification.
