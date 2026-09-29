FROM python:3.12-slim
# curl is handy for `kubectl exec ... -- curl` while learning.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
ARG VERSION=dev
ENV VERSION=$VERSION PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py .
# Run as a non-root user.
USER 1000
EXPOSE 8080
CMD ["python", "server.py"]
