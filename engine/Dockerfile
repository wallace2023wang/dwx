ARG BUILD_IMAGE=docker.1ms.run/library/maven:3.9.11-eclipse-temurin-17
ARG RUNTIME_IMAGE=docker.1ms.run/library/eclipse-temurin:17-jre
FROM ${BUILD_IMAGE} AS build
WORKDIR /app
COPY pom.xml .
COPY settings.xml .
COPY src ./src
RUN mvn -q -B -s settings.xml -DskipTests package

FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=build /app/target/rules-engine.jar ./rules-engine.jar
EXPOSE 8788
CMD ["java", "-jar", "rules-engine.jar"]
