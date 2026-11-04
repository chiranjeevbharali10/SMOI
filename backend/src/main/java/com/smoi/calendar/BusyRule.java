package com.smoi.calendar;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * "Suspiciously busy" (shown on the calendar screen and in the panel). A day counts as busy when
 * either:
 * <ul>
 *   <li>its timed events add up to at least {@code meetingHours} (overlaps counted once), or</li>
 *   <li>at least {@code backToBack} events follow each other with less than {@code gapMinutes}
 *       between one's end and the next one's start.</li>
 * </ul>
 * All-day events don't count. Defaults: 6 hours, 3 back to back, 10 minutes. These are a judgement
 * call, not a measurement, and are settings ({@code smoi.google.busy.*}).
 *
 * <p>Pure, so it is unit-tested in {@code BusyRuleTest}.
 */
public final class BusyRule {

    public record Interval(Instant start, Instant end) {
    }

    public record Verdict(boolean busy, Duration booked, int longestRun, String reason) {
    }

    private BusyRule() {
    }

    public static Verdict judge(List<Interval> events, double meetingHours, int backToBack, int gapMinutes) {
        List<Interval> sorted = new ArrayList<>(events);
        sorted.sort(Comparator.comparing(Interval::start));

        // Total booked time, merging overlaps so two parallel meetings don't count twice.
        Duration booked = Duration.ZERO;
        Instant curStart = null;
        Instant curEnd = null;
        for (Interval i : sorted) {
            if (curEnd == null || i.start().isAfter(curEnd)) {
                if (curEnd != null) {
                    booked = booked.plus(Duration.between(curStart, curEnd));
                }
                curStart = i.start();
                curEnd = i.end();
            } else if (i.end().isAfter(curEnd)) {
                curEnd = i.end();
            }
        }
        if (curEnd != null) {
            booked = booked.plus(Duration.between(curStart, curEnd));
        }

        // Longest chain of events with short (or no, or negative) gaps between them.
        int longest = sorted.isEmpty() ? 0 : 1;
        int run = 1;
        Instant runEnd = sorted.isEmpty() ? null : sorted.get(0).end();
        for (int k = 1; k < sorted.size(); k++) {
            Interval i = sorted.get(k);
            if (Duration.between(runEnd, i.start()).toMinutes() < gapMinutes) {
                run++;
            } else {
                run = 1;
            }
            runEnd = i.end().isAfter(runEnd) || run == 1 ? i.end() : runEnd;
            longest = Math.max(longest, run);
        }

        boolean tooLong = booked.toMinutes() >= Math.round(meetingHours * 60);
        boolean tooPacked = longest >= backToBack;
        String reason = tooLong ? "%s booked today".formatted(hours(booked))
                : tooPacked ? "%d meetings back to back".formatted(longest) : null;
        return new Verdict(tooLong || tooPacked, booked, longest, reason);
    }

    private static String hours(Duration d) {
        long m = d.toMinutes();
        return m % 60 == 0 ? (m / 60) + " h" : (m / 60) + " h " + (m % 60) + " min";
    }
}
