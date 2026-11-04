package com.smoi.google;

import java.util.List;
import java.util.Set;

/**
 * The only Google scopes SMOI asks for (NFR-03.05). Adding one needs an ADR. The explanations are
 * shown in the desktop app before connecting.
 */
public final class GoogleScopes {

    public static final String CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
    public static final String GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
    public static final String GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

    public static final List<String> ALL = List.of(CALENDAR_EVENTS, GMAIL_READONLY, GMAIL_COMPOSE);

    public record Explained(String scope, String name, String why) {
    }

    public static final List<Explained> EXPLAINED = List.of(
            new Explained(CALENDAR_EVENTS, "calendar.events",
                    "See your upcoming events, and create, change or delete events after you confirm each change."),
            new Explained(GMAIL_READONLY, "gmail.readonly",
                    "Read recent unread mail to sort and summarise it. Reading never marks mail as read."),
            new Explained(GMAIL_COMPOSE, "gmail.compose",
                    "Create and update drafts for you to review and send yourself. Google's permission would also "
                            + "allow sending, but SMOI has no code that sends, deletes or trashes mail."));

    private GoogleScopes() {
    }

    public static boolean has(String granted, String scope) {
        return granted != null && Set.of(granted.split(" ")).contains(scope);
    }
}
