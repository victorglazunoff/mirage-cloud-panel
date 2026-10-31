import type { CalendarItem, HomeScheduledEvent } from '@/shared/types';

/**
 * The home calendar block on `/api/calendar/events`: calls, messages, meetings
 * and Claude's tasks (scheduled messages included) as home event rows.
 * Cancelled events and server timers are left out.
 */
export function calendarItemsToHomeEvents(items: CalendarItem[]): HomeScheduledEvent[] {
  return items
    .filter((item) => item.type !== 'server_schedule' && item.status !== 'cancelled')
    .map((item) => {
      const who = item.contact?.name ?? item.location ?? null;
      return {
        id: item.id,
        sessionId: item.sessionId ?? '',
        projectId: item.projectId,
        projectName: item.projectName ?? (item.source === 'google' ? 'Google' : 'Без проекта'),
        sessionTitle: item.agent?.sessionTitle ?? item.title,
        preview: item.agent?.content.replace(/\s+/g, ' ').trim() ?? who ?? item.note?.replace(/\s+/g, ' ').trim() ?? '',
        scheduledFor: item.startsAt,
        endsAt: item.endsAt,
        calendar: { eventId: item.occurrenceOf ?? item.id, type: item.type, title: item.title, done: item.status === 'done' },
      };
    })
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}
