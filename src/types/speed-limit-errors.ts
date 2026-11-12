export type ProviderErrorCode = 'request_failed' | 'invalid_response' | 'request_limit' | 'authentication_failed' | 'quota_exceeded' | 'timeout' | 'invalid_trace';

/** Sanitized diagnostics; never retain the raw provider URL/error/body. */
export class SpeedLimitProviderError extends Error {
    readonly code: ProviderErrorCode;
    readonly retryable: boolean;
    readonly httpStatus: number | undefined;
    constructor(code: ProviderErrorCode, httpStatus?: number) {
        super(`Speed limit provider: ${code}`);
        this.code = code;
        this.httpStatus = httpStatus;
        this.retryable = !['request_limit', 'authentication_failed', 'invalid_trace'].includes(code);
    }
}
