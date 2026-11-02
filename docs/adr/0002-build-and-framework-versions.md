# 0002: Maven, Spring Boot 4.1 and pinned infrastructure versions

- Status: Accepted
- Date: 2026-11-02

## Context

The original plan said "Spring Boot 3". When the project started on 2026-11-02, the checks gave:

- Spring Boot 3.5, the last 3.x line, reached the end of open-source support on 2026-06-30. Its
  final release is 3.5.16 (2026-06-25). Further fixes are commercial only.
- Spring Boot 4.1.2 (released 2026-10-22) is the current stable release. Open-source support runs
  until 2027-07-31, and it supports Java 17 to 26.

Sources: Maven Central metadata for `spring-boot-starter-parent` and endoflife.date/spring-boot.

## Decision

- **Spring Boot 4.1.2** on **Java 21** (LTS).
- **Maven**, run through the Maven wrapper (`./mvnw`, Maven 3.9.15), so CI and every machine
  use the same Maven version.
- Library versions (Spring Security 7.1.2, Flyway 12.4.0, Testcontainers 2.0.5, PostgreSQL
  JDBC 42.7.14) come from Spring Boot's dependency management. We do not override them.
- Database image: `pgvector/pgvector:0.8.7-pg18-trixie` (pgvector 0.8.7 on PostgreSQL 18). Compose and
  the tests use the same image.
- Data access uses Spring `JdbcClient` with handwritten SQL, so every `user_id` filter is visible
  in the code.

## Alternatives rejected

- **Spring Boot 3.5.16.** It matched the original plan, but it no longer receives free security fixes.
  Starting a new project on an end-of-life line is hard to defend in an interview.
- **Gradle.** It's capable and fast, but Maven is more common in Java backend job postings, and its
  declarative POM is easier to explain line by line.
- **Spring Data JPA / Hibernate.** It hides the SQL. Retrieval (Phase 2) needs handwritten pgvector
  and full-text SQL anyway, and per-user filtering must be easy to audit.
- **Overriding Boot-managed versions to the newest library releases** (for example Flyway 13). Boot
  tests its managed set together, and mixing versions adds risk with no benefit yet.

## Consequences

- Spring Boot 4 uses Jackson 3 and smaller, more modular starters. Some online examples written for Boot 3
  need small changes.
- Upgrade to the next Boot minor before 4.1 support ends (2027-07-31).
