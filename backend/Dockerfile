FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server ./cmd/server \
 && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/worker ./cmd/worker \
 && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/migrate-legacy ./cmd/migrate-legacy

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/server /out/worker /out/migrate-legacy /usr/local/bin/
USER nobody
EXPOSE 8080
CMD ["server"]
