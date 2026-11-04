package com.smoi.actions;

import java.util.UUID;

/** Lets tests in other packages reach package-private helpers of {@link GoogleActionService}. */
public final class GoogleActionServiceTestAccess {

    private GoogleActionServiceTestAccess() {
    }

    public static String eventId(UUID actionId) {
        return GoogleActionService.googleEventId(actionId);
    }
}
