package com.smoi.command;

import java.time.Instant;
import java.time.ZoneId;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The model's reply is untrusted: only allowlisted intents and checked fields get through. */
class CommandParserTest {

    private static final ZoneId LONDON = ZoneId.of("Europe/London");
    private static final Instant NOW = Instant.parse("2026-11-03T10:00:00Z");

    private static Proposal parse(String reply) {
        return CommandParser.parse(reply, LONDON, NOW);
    }

    @Test
    void readsATaskAndAttachesTheUsersTimeZone() {
        Proposal p = parse("{\"intent\":\"create_task\",\"title\":\"  Buy   oat milk \",\"when\":\"2026-11-06T09:00\",\"priority\":\"high\"}");

        assertThat(p.intent()).isEqualTo("create_task");
        assertThat(p.task().title()).isEqualTo("Buy oat milk");
        assertThat(p.task().dueAt()).isEqualTo(Instant.parse("2026-11-06T09:00:00Z"));
        assertThat(p.task().priority()).isEqualTo("high");
        assertThat(p.problem()).isNull();
    }

    @Test
    void usesTheTimeZoneOffsetInSummer() {
        Proposal p = parse("{\"intent\":\"create_task\",\"title\":\"x\",\"when\":\"2027-07-01T09:00\"}");

        assertThat(p.task().dueAt()).isEqualTo(Instant.parse("2027-07-01T08:00:00Z"));
    }

    @Test
    void anUnknownPriorityBecomesNormal() {
        assertThat(parse("{\"intent\":\"create_task\",\"title\":\"x\",\"priority\":\"urgent!!\"}").task().priority())
                .isEqualTo("normal");
    }

    @Test
    void readsARecurringReminder() {
        Proposal p = parse("```json\n{\"intent\":\"create_reminder\",\"title\":\"Stretch\",\"when\":\"2026-11-03T15:00\","
                + "\"repeat\":\"weekdays\",\"days\":[\"Mon\",\"wednesday\",\"fri\",\"funday\"]}\n```");

        assertThat(p.reminder().repeat()).isEqualTo("weekdays");
        assertThat(p.reminder().weekdays()).isEqualTo(1 | 4 | 16);
        assertThat(p.reminder().firstAt()).isEqualTo(Instant.parse("2026-11-03T15:00:00Z"));
    }

    @Test
    void aOneTimeReminderInThePastIsAProblemNotAReminder() {
        Proposal p = parse("{\"intent\":\"create_reminder\",\"title\":\"x\",\"when\":\"2026-11-03T08:00\"}");

        assertThat(p.reminder()).isNull();
        assertThat(p.problem()).isEqualTo("That time has already passed.");
    }

    @Test
    void aReminderWithoutATimeIsAProblem() {
        Proposal p = parse("{\"intent\":\"create_reminder\",\"title\":\"x\",\"when\":\"tomorrow-ish\"}");

        assertThat(p.reminder()).isNull();
        assertThat(p.problem()).isEqualTo("I couldn't work out when to remind you.");
    }

    @Test
    void readsAQuestion() {
        Proposal p = parse("{\"intent\":\"ask_brain\",\"question\":\" Where do natterjacks live? \"}");

        assertThat(p.question()).isEqualTo("Where do natterjacks live?");
    }

    @Test
    void calendarAndEmailIntentsAreRecognisedButNotAvailable() {
        Proposal p = parse("{\"intent\":\"draft_email\",\"to\":\"boss@example.com\"}");

        assertThat(p.intent()).isEqualTo("draft_email");
        assertThat(p.available()).isFalse();
        assertThat(p.task()).isNull();
        assertThat(p.reminder()).isNull();
    }

    @Test
    void anIntentOffTheAllowlistIsUnknown() {
        Proposal p = parse("{\"intent\":\"delete_all_tasks\",\"title\":\"everything\"}");

        assertThat(p.intent()).isEqualTo("unknown");
        assertThat(p.task()).isNull();
    }

    @Test
    void aReplyThatIsNotJsonIsUnknown() {
        assertThat(parse("Sure! I'll add that for you.").intent()).isEqualTo("unknown");
        assertThat(parse("{not json}").intent()).isEqualTo("unknown");
        assertThat(parse(null).intent()).isEqualTo("unknown");
    }

    @Test
    void fieldsOfTheWrongTypeAreIgnored() {
        Proposal p = parse("{\"intent\":\"create_task\",\"title\":42}");

        assertThat(p.task()).isNull();
        assertThat(p.problem()).isEqualTo("I couldn't tell what the task is.");
    }

    // ---- the model copies the day and time; the date is worked out here (NOW is Tue 3 Nov 10:00) ----

    private static Instant reminderAt(String fields) {
        return parse("{\"intent\":\"create_reminder\",\"title\":\"x\"," + fields + "}").reminder().firstAt();
    }

    @Test
    void tomorrowAtSixPm() {
        assertThat(reminderAt("\"day\":\"tomorrow\",\"time\":\"6pm\"")).isEqualTo(Instant.parse("2026-11-04T18:00:00Z"));
        assertThat(reminderAt("\"day\":\"tomorrow\",\"time\":\"18:00\"")).isEqualTo(Instant.parse("2026-11-04T18:00:00Z"));
        assertThat(reminderAt("\"day\":\"tomorrow\",\"time\":\"6:30 p.m.\"")).isEqualTo(Instant.parse("2026-11-04T18:30:00Z"));
    }

    @Test
    void aWeekdayIsTheNextOneTodayIncludedIfTheTimeIsAhead() {
        assertThat(reminderAt("\"day\":\"friday\",\"time\":\"09:00\"")).isEqualTo(Instant.parse("2026-11-06T09:00:00Z"));
        assertThat(reminderAt("\"day\":\"tuesday\",\"time\":\"15:00\"")).isEqualTo(Instant.parse("2026-11-03T15:00:00Z"));
        assertThat(reminderAt("\"day\":\"tuesday\",\"time\":\"08:00\"")).isEqualTo(Instant.parse("2026-11-10T08:00:00Z"));
    }

    @Test
    void aTimeAloneIsTodayOrTomorrowIfItHasPassed() {
        assertThat(reminderAt("\"time\":\"15:00\"")).isEqualTo(Instant.parse("2026-11-03T15:00:00Z"));
        assertThat(reminderAt("\"time\":\"8am\"")).isEqualTo(Instant.parse("2026-11-04T08:00:00Z"));
    }

    @Test
    void inMinutesCountsFromNow() {
        assertThat(reminderAt("\"inMinutes\":20")).isEqualTo(NOW.plusSeconds(1200));
    }

    @Test
    void aWeekdayReminderWithoutADayStartsOnTheFirstMatchingDay() {
        Proposal p = parse("{\"intent\":\"create_reminder\",\"title\":\"Water\",\"time\":\"07:30\",\"repeat\":\"weekdays\",\"days\":[\"mon\",\"thu\"]}");
        assertThat(p.reminder().firstAt()).isEqualTo(Instant.parse("2026-11-05T07:30:00Z"));
    }

    @Test
    void aTaskForFridayIsDueAtNine() {
        Proposal p = parse("{\"intent\":\"create_task\",\"title\":\"Buy oat milk\",\"day\":\"friday\"}");
        assertThat(p.task().dueAt()).isEqualTo(Instant.parse("2026-11-06T09:00:00Z"));
    }

    @Test
    void nonsenseTimesAreAProblem() {
        Proposal p = parse("{\"intent\":\"create_reminder\",\"title\":\"x\",\"day\":\"someday\",\"time\":\"25:99\"}");
        assertThat(p.problem()).isEqualTo("I couldn't work out when to remind you.");
        assertThat(parse("{\"intent\":\"create_reminder\",\"title\":\"x\",\"inMinutes\":-5}").problem()).isNotNull();
    }

    // ---- fields the model made up are dropped ----

    @Test
    void aDayTheUserDidNotSayIsDropped() {
        Proposal p = CommandParser.parse("{\"intent\":\"create_reminder\",\"title\":\"Call mum\",\"day\":\"tomorrow\",\"time\":\"21:00\"}",
                "remind me to call mum at 9pm", LONDON, NOW);
        assertThat(p.reminder().firstAt()).isEqualTo(Instant.parse("2026-11-03T21:00:00Z"));
    }

    @Test
    void aDueDateTheUserDidNotSayIsDropped() {
        Proposal p = CommandParser.parse("{\"intent\":\"create_task\",\"title\":\"Renew passport\",\"day\":\"tomorrow\",\"time\":\"18:00\"}",
                "add renew passport to my tasks, it is high priority", LONDON, NOW);
        assertThat(p.task().dueAt()).isNull();
    }

    @Test
    void daysAndTimesTheUserSaidAreKept() {
        Proposal p = CommandParser.parse("{\"intent\":\"create_task\",\"title\":\"x\",\"day\":\"friday\"}",
                "add x for fri", LONDON, NOW);
        assertThat(p.task().dueAt()).isEqualTo(Instant.parse("2026-11-06T09:00:00Z"));
    }
}
