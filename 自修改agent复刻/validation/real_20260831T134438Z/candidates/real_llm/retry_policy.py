'''Stable version 1.0.1. Fixed to respect retryable flag and permanent error codes.'''

VERSION = '1.0.1'
MAX_RETRIES = 3
CIRCUIT_BREAKER_THRESHOLD = 5
NON_RETRYABLE_CODES = {'AUTH_DENIED', 'INVALID_ARGUMENT', 'PAYMENT_DECLINED'}

def should_retry(error_code, retryable, attempt):
    '''Return whether another tool call should be attempted.'''
    # Permanent failures (retryable=False or listed permanent code) are not retried.
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return False
    return attempt < MAX_RETRIES

def should_open_circuit(consecutive_failures, *, error_code='', retryable=True):
    '''Open after repeated failures.'''
    # Permanent failures open the circuit immediately.
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return True
    return consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD
