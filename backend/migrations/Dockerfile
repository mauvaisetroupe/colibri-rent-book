# Migration image (ADR 0026, docs/exploitation.md): Flyway with the migrations of this folder. Applies what is missing,
# then stops; the API is started after it. Locally:
#   docker build -t colibri-rent-book-migrations backend/migrations

FROM flyway/flyway:13.11.1-alpine

COPY *.sql /flyway/sql/

ENV FLYWAY_LOCATIONS=filesystem:/flyway/sql \
    # Wait for the database when both start together
    FLYWAY_CONNECT_RETRIES=10 \
    # Never drop the schema, whatever the configuration given
    FLYWAY_CLEAN_DISABLED=true \
    # A badly named file fails instead of being silently skipped
    FLYWAY_VALIDATE_MIGRATION_NAMING=true \
    REDGATE_DISABLE_TELEMETRY=true

USER 65532:65532

CMD ["migrate"]
