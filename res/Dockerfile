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
COPY --from=build /app/target/rules-res.jar ./rules-res.jar
COPY config ./config
RUN mkdir -p /data/releases
EXPOSE 8790 8793
ENV RES_DATA_DIR=/data/releases
CMD ["java", "-jar", "rules-res.jar"]
