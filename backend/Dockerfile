# ---- build stage ---------------------------------------------------------------
FROM eclipse-temurin:21-jdk-noble AS build
WORKDIR /workspace

# Download dependencies in their own layer so code changes don't re-download them.
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN chmod +x mvnw && ./mvnw -B -q dependency:go-offline

COPY src/ src/
# Tests run in CI and locally with Testcontainers, which needs Docker and isn't available inside this build.
RUN ./mvnw -B -q package -DskipTests

# ---- runtime stage -------------------------------------------------------------
FROM eclipse-temurin:21-jre-noble
WORKDIR /app

RUN groupadd --system smoi && useradd --system --gid smoi --no-create-home smoi
COPY --from=build /workspace/target/smoi-backend-*.jar app.jar
USER smoi

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
