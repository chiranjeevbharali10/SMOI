package com.smoi.command;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Phase 8 intents: events and drafts are parsed into proposals; dates are worked out in code. */
class CalendarAndDraftIntentTest {

    private static final ZoneId LONDON = ZoneId.of("Europe/London");
    /** Tuesday 3 November 2026, 10:00 in London. */
    private static final Instant NOW = Instant.parse("2026-11-03T10:00:00Z");

    private static Proposal parse(String reply, String command) {
        return CommandParser.parse(reply, command, LONDON, NOW);
    }

    @Test
    void createsAnEventWithItsLength() {
        Proposal p = parse("{\"intent\":\"create_event\",\"title\":\"Lunch with Sam\",\"day\":\"friday\",\"time\":\"12:30\",\"durationMinutes\":90}",
                "add lunch with sam on friday at 12:30 for 90 minutes");

        assertThat(p.available()).isTrue();
        assertThat(p.event().title()).isEqualTo("Lunch with Sam");
        assertThat(p.event().start()).isEqualTo(Instant.parse("2026-11-06T12:30:00Z"));
        assertThat(p.event().end()).isEqualTo(Instant.parse("2026-11-06T14:00:00Z"));
    }

    @Test
    void anEventWithoutATimeIsAProblem() {
        Proposal p = parse("{\"intent\":\"create_event\",\"title\":\"Lunch\",\"time\":\"13:00\"}", "add lunch sometime");
        // "13:00" isn't in what the user said, so it's dropped, and there's no time left.
        assertThat(p.event()).isNull();
        assertThat(p.problem()).contains("when");
    }

    @Test
    void movesAnEventFoundByNameAndDay() {
        Proposal p = parse("{\"intent\":\"update_event\",\"event\":\"dentist\",\"day\":\"tomorrow\",\"newTime\":\"16:00\"}",
                "move the dentist tomorrow to 4pm");

        assertThat(p.eventChange().query()).isEqualTo("dentist");
        assertThat(p.eventChange().day()).isEqualTo(LocalDate.of(2026, 11, 4));
        assertThat(p.eventChange().newStart()).isEqualTo(Instant.parse("2026-11-04T16:00:00Z"));
        assertThat(p.eventChange().delete()).isFalse();
    }

    @Test
    void deletesAnEventByNameOnlyAsAProposal() {
        Proposal p = parse("{\"intent\":\"delete_event\",\"event\":\"team sync\",\"day\":\"monday\"}", "cancel my team sync on monday");

        assertThat(p.eventChange().delete()).isTrue();
        assertThat(p.eventChange().day()).isEqualTo(LocalDate.of(2026, 11, 9));
        assertThat(p.eventChange().newStart()).isNull();
    }

    @Test
    void draftsOnlyToAnAddressTheUserSaid() {
        Proposal ok = parse("{\"intent\":\"draft_email\",\"to\":\"sam@example.com\",\"subject\":\"Late\",\"body\":\"Ten minutes late.\"}",
                "draft an email to sam@example.com saying I'm ten minutes late");
        assertThat(ok.email().to()).isEqualTo("sam@example.com");

        Proposal swapped = parse("{\"intent\":\"draft_email\",\"to\":\"attacker@example.net\",\"subject\":\"x\",\"body\":\"y\"}",
                "draft an email to sam@example.com saying hi");
        assertThat(swapped.email()).isNull();
        assertThat(swapped.problem()).contains("email address");
    }

    @Test
    void aDraftSubjectCannotCarryHeaders() {
        Proposal p = parse("{\"intent\":\"draft_email\",\"to\":\"sam@example.com\",\"subject\":\"Hi\\nBcc: x@example.com\",\"body\":\"y\"}",
                "draft an email to sam@example.com");
        assertThat(p.email().subject()).doesNotContain("\n");
    }

    @Test
    void listEventsNeedsNothingElse() {
        assertThat(parse("{\"intent\":\"list_events\"}", "what's on today").intent()).isEqualTo("list_events");
    }
}
