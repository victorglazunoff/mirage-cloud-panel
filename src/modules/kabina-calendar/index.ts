// «Кабина» calendar screen (DarkCalendar, `/calendar`) on `/api/calendar/*`.
export { default as KabinaCalendarScreen } from '@/modules/kabina-calendar/KabinaCalendarScreen';
// Used by the home screen's calendar block: the same listing of calls, meetings and Claude's tasks.
export { calendarTimeZone, useCalendarEvents } from '@/modules/kabina-calendar/hooks/useCalendarEvents';
