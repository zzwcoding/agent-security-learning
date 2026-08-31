"""Stable version 1.0.1-candidate. It fixes the retry policy for permanent failures."""

VERSION = "1.0.1-candidate"
MAX_RETRIES = 3
CIRCUIT_BREAKER_THRESHOLD = 5
NON_RETRYABLE_CODES = {"AUTH_DENIED", "INVALID_ARGUMENT"}


def should_retry(error_code, retryable, attempt):
    """Return whether another tool call should be attempted."""
    # Do not retry permanent failures.
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return False
    # For temporary failures, allow up to MAX_RETRIES retries.
    return attempt < MAX_RETRIES


def should_open_circuit(consecutive_failures, *, error_code="", retryable=True):
    """Open after repeated failures."""
    # Permanent failures open circuit on the first occurrence.
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return consecutive_failures >= 1
    # Otherwise, use the threshold.
    return consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD
