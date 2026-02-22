/**
 * API client for the Enterprise AI Platform backend.
 * All calls go through the API Gateway (port 8000).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ─── Types ───

export interface LoginRequest {
    email: string;
    password: string;
}

export interface LoginResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    user: {
        id: string;
        email: string;
        full_name: string;
        role: string;
        roles?: string[];
        tenant_id: string;
    };
}

export interface RegisterRequest {
    email: string;
    password: string;
    full_name: string;
}

export interface ApiError {
    detail: string;
}

export interface HealthResponse {
    status: string;
    service: string;
    version?: string;
}

// ─── Error class ───

export class ApiRequestError extends Error {
    status: number;
    data: ApiError;
    traceId: string | null;

    constructor(status: number, data: ApiError, traceId: string | null = null) {
        super(data.detail || `Request failed with status ${status}`);
        this.status = status;
        this.data = data;
        this.traceId = traceId;
    }
}

// ─── Auto-refresh state ───

let _refreshPromise: Promise<boolean> | null = null;
let _onTokenRefreshed: ((newToken: string) => void) | null = null;

/** Register a callback from AuthProvider so apiRequest can update the stored token. */
export function setTokenRefreshCallback(cb: (newToken: string) => void) {
    _onTokenRefreshed = cb;
}

async function _tryRefresh(): Promise<boolean> {
    // Deduplicate: if a refresh is already in flight, reuse it
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = (async () => {
        try {
            const resp = await fetch(`${API_BASE}/auth/refresh`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            if (data.access_token && _onTokenRefreshed) {
                _onTokenRefreshed(data.access_token);
            }
            return !!data.access_token;
        } catch {
            return false;
        } finally {
            _refreshPromise = null;
        }
    })();

    return _refreshPromise;
}

// ─── Helper ───

async function apiRequest<T>(
    path: string,
    options: RequestInit = {},
    _isRetry = false,
): Promise<T> {
    const url = `${API_BASE}${path}`;

    // Auto-attach Idempotency-Key for POST requests (gateway caches 5min)
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string> || {}),
    };
    if (options.method === "POST" && !headers["Idempotency-Key"]) {
        headers["Idempotency-Key"] = crypto.randomUUID();
    }

    const resp = await fetch(url, {
        ...options,
        credentials: "include", // Important: send/receive HttpOnly cookies
        headers,
    });

    // Capture trace ID from gateway for debugging
    const traceId = resp.headers.get("X-Trace-Id");

    const data = await resp.json().catch(() => ({ detail: "Unknown error" }));

    if (!resp.ok) {
        // Auto-refresh: on 401 (expired token), try refresh once then retry
        if (resp.status === 401 && !_isRetry && !path.startsWith("/auth/")) {
            const refreshed = await _tryRefresh();
            if (refreshed) {
                // Retry the original request (will pick up new token from caller)
                return apiRequest<T>(path, options, true);
            }
        }
        throw new ApiRequestError(resp.status, data as ApiError, traceId);
    }

    return data as T;
}

// ─── Auth API ───

export const authApi = {
    login: (data: LoginRequest) =>
        apiRequest<LoginResponse>("/auth/login", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    register: (data: RegisterRequest) =>
        apiRequest<LoginResponse>("/auth/register", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    refresh: () =>
        apiRequest<{ access_token: string; token_type: string; expires_in: number }>(
            "/auth/refresh",
            { method: "POST" }
        ),

    logout: (token: string) =>
        apiRequest<{ message: string }>("/auth/logout", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    me: (token: string) =>
        apiRequest<Record<string, unknown>>("/auth/me", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    changePassword: (token: string, data: { old_password: string; new_password: string }) =>
        apiRequest<{ message: string; sessions_revoked: boolean }>("/auth/change-password", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    getSessions: (token: string) =>
        apiRequest<SessionInfo[]>("/auth/sessions", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    revokeSession: (token: string, sessionId: string) =>
        apiRequest<{ message: string }>(`/auth/sessions/${sessionId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),

    logoutAll: (token: string) =>
        apiRequest<{ message: string; revoked_count: number }>("/auth/logout-all", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    getLoginActivity: (token: string, limit: number = 50) =>
        apiRequest<LoginActivityItem[]>(`/auth/login-activity?limit=${limit}`, {
            headers: { Authorization: `Bearer ${token}` },
        }),

    healthz: () =>
        apiRequest<HealthResponse>("/healthz"),
};

// ─── Session / Activity Types ───

export interface SessionInfo {
    id: string;
    ip: string | null;
    user_agent: string | null;
    status: string;
    is_current: boolean;
    created_at: string | null;
    last_seen: string | null;
    revoked_at: string | null;
}

export interface LoginActivityItem {
    timestamp: string | null;
    action: string;
    status: string;
    ip: string | null;
    user_agent: string | null;
    detail: string | null;
}

// ─── API Key Types ───

export interface ApiKeyInfo {
    id: string;
    name: string;
    prefix: string;
    status: string;
    scopes: string | null;
    rpm_limit: number | null;
    daily_token_limit: number | null;
    daily_tokens_used: number | null;
    created_at: string | null;
    rotated_at: string | null;
}

export interface CreatedApiKeyResponse {
    id: string;
    name: string;
    key: string; // plaintext — shown ONCE
    prefix: string;
    scopes: string | null;
    rpm_limit: number | null;
    daily_token_limit: number | null;
    message: string;
}

export interface RotatedApiKeyResponse {
    old_key_id: string;
    new_key_id: string;
    new_key: string; // plaintext — shown ONCE
    status: string;
    message: string;
}

// ─── API Key API ───

export const apiKeyApi = {
    create: (token: string, data: { name?: string; scopes?: string; rpm_limit?: number; daily_token_limit?: number }) =>
        apiRequest<CreatedApiKeyResponse>("/auth/api-keys", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    list: (token: string) =>
        apiRequest<ApiKeyInfo[]>("/auth/api-keys", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    rotate: (token: string, keyId: string) =>
        apiRequest<RotatedApiKeyResponse>(`/auth/api-keys/${keyId}/rotate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    finalize: (token: string, keyId: string) =>
        apiRequest<{ message: string; retired_key_id: string; active_key_id: string }>(`/auth/api-keys/${keyId}/finalize`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    revoke: (token: string, keyId: string) =>
        apiRequest<{ message: string }>(`/auth/api-keys/${keyId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),
};

// ─── File Types ───

export interface FileInfo {
    id: string;
    filename: string;
    mime_type: string | null;
    size: number;
    status: string;
    chunks_total: number;
    chunks_processed: number;
    created_at: string | null;
}

export interface UploadInitResponse {
    file_id: string;
    upload_url: string;
    storage_key: string;
}

export interface FileViewResponse {
    url: string;
    filename: string;
}

// ─── File API ───

export const fileApi = {
    initUpload: (token: string, data: { filename: string; mime_type: string; size: number }) =>
        apiRequest<UploadInitResponse>("/files/upload/init", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    directUpload: (token: string, file: File, onProgress?: (pct: number) => void): Promise<{ file_id: string; filename: string; status: string; size: number }> => {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append("file", file);

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_BASE}/files/upload/direct`, true);
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);

            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable && onProgress) {
                    onProgress(Math.round((ev.loaded / ev.total) * 100));
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try {
                        const err = JSON.parse(xhr.responseText);
                        reject(new Error(err.detail || `Upload failed: ${xhr.status}`));
                    } catch {
                        reject(new Error(`Upload failed: ${xhr.status}`));
                    }
                }
            };
            xhr.onerror = () => reject(new Error("Upload network error"));
            xhr.send(formData);
        });
    },

    completeUpload: (token: string, fileId: string) =>
        apiRequest<FileInfo>(`/files/upload/complete?file_id=${fileId}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    list: (token: string, status?: string) => {
        const qs = status ? `?status=${status}` : "";
        return apiRequest<FileInfo[]>(`/files${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    get: (token: string, fileId: string) =>
        apiRequest<FileInfo>(`/files/${fileId}`, {
            headers: { Authorization: `Bearer ${token}` },
        }),

    getViewUrl: (token: string, fileId: string) => {
        // Direct streaming URL through gateway — token as query param for iframe/img
        return Promise.resolve({ url: `${API_BASE}/files/${fileId}/view?token=${encodeURIComponent(token)}`, filename: "" });
    },

    delete: (token: string, fileId: string) =>
        apiRequest<{ message: string }>(`/files/${fileId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),
};

// ─── LLM Chat Types ───

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    citations: Citation[] | null;
    file_ids: string[] | null;
    tokens: { prompt: number; completion: number; total: number } | null;
    model: string | null;
    created_at: string | null;
}

export interface Citation {
    file_id?: string;
    filename?: string;
    chunk_index?: number;
    page?: number;
    text?: string;
    score?: number;
    [key: string]: unknown;
}

export interface ChatResponseData {
    answer: string;
    conversation_id: string;
    message_id: string;
    citations: Citation[] | null;
    usage_tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    no_evidence: boolean;
    invalid_citation_count?: number;
}

export interface ConversationItem {
    id: string;
    title: string;
    created_at: string | null;
    updated_at: string | null;
}

export interface ConversationDetail {
    id: string;
    title: string;
    messages: ChatMessage[];
}

// ─── LLM API ───

export const llmApi = {
    chat: (token: string, data: { message: string; conversation_id?: string; file_ids?: string[] }) =>
        apiRequest<ChatResponseData>("/llm/chat", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    chatUpload: async (token: string, file: File): Promise<{ file_id: string; filename: string }> => {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${API_BASE}/llm/chat/upload`, {
            method: "POST",
            body: formData,
            headers: { Authorization: `Bearer ${token}` },
            credentials: "include",
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({ detail: res.statusText }));
            throw new ApiRequestError(res.status, data);
        }
        return res.json();
    },

    listConversations: (token: string) =>
        apiRequest<ConversationItem[]>("/llm/conversations", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    getConversation: (token: string, convId: string) =>
        apiRequest<ConversationDetail>(`/llm/conversations/${convId}`, {
            headers: { Authorization: `Bearer ${token}` },
        }),

    deleteConversation: (token: string, convId: string) =>
        apiRequest<{ message: string }>(`/llm/conversations/${convId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),
};

// ─── Memory Types ───

export interface MemoryItem {
    key: string;
    value: string;
    category: string;
    created_at?: string;
    updated_at?: string;
}

// ─── Memory API ───

export const memoryApi = {
    list: (token: string) =>
        apiRequest<MemoryItem[]>("/llm/memory", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    set: (token: string, data: { key: string; value: string; category?: string }) =>
        apiRequest<{ message: string }>("/llm/memory", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    delete: (token: string, key: string) =>
        apiRequest<{ message: string }>(`/llm/memory/${encodeURIComponent(key)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),

    purge: (token: string) =>
        apiRequest<{ message: string }>("/llm/memory/purge", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),
};

// ─── Usage Types ───

export interface UsageMessage {
    id: string;
    conversation_id: string | null;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number | null;
    rag_latency_ms: number | null;
    infer_latency_ms: number | null;
    created_at: string | null;
}

export interface UsageAggregate {
    period: string;
    request_count: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    avg_rag_latency_ms: number;
    avg_infer_latency_ms: number;
}

// ─── Usage API ───

export const usageApi = {
    messages: (token: string, conversationId?: string) => {
        const qs = conversationId ? `?conversation_id=${conversationId}` : "";
        return apiRequest<UsageMessage[]>(`/usage/messages${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    daily: (token: string, fromDate?: string, toDate?: string) => {
        const params = new URLSearchParams();
        if (fromDate) params.set("from_date", fromDate);
        if (toDate) params.set("to_date", toDate);
        const qs = params.toString() ? `?${params}` : "";
        return apiRequest<UsageAggregate[]>(`/usage/daily${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    weekly: (token: string, fromDate?: string, toDate?: string) => {
        const params = new URLSearchParams();
        if (fromDate) params.set("from_date", fromDate);
        if (toDate) params.set("to_date", toDate);
        const qs = params.toString() ? `?${params}` : "";
        return apiRequest<UsageAggregate[]>(`/usage/weekly${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    monthly: (token: string, fromDate?: string, toDate?: string) => {
        const params = new URLSearchParams();
        if (fromDate) params.set("from_date", fromDate);
        if (toDate) params.set("to_date", toDate);
        const qs = params.toString() ? `?${params}` : "";
        return apiRequest<UsageAggregate[]>(`/usage/monthly${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },
};

// ─── Admin / Monitoring Types ───

export interface DashboardStats {
    events_today: number;
    security_events_today: number;
    llm_requests_today: number;
    tokens_today: number;
    cost_today_usd: number;
    open_alerts: number;
    timestamp: string;
}

export interface EventLogItem {
    id: string;
    timestamp: string | null;
    trace_id: string | null;
    user_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    status: string;
    ip: string | null;
    user_agent: string | null;
    detail: string | null;
}

export interface SecurityLogItem {
    id: string;
    timestamp: string | null;
    trace_id: string | null;
    user_id: string | null;
    event_type: string;
    severity: string;
    detail: string | null;
    ip: string | null;
    prev_hash: string | null;
}

export interface LLMUsageLogItem {
    id: string;
    user_id: string | null;
    conversation_id: string | null;
    trace_id: string | null;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number | null;
    rag_latency_ms: number | null;
    infer_latency_ms: number | null;
    pipeline_version: string | null;
    citation_count: number | null;
    citation_invalid_count: number | null;
    created_at: string | null;
}

export interface AlertItem {
    id: string;
    rule_name: string;
    severity: string;
    message: string;
    trace_id: string | null;
    status: string;
    created_at: string | null;
    resolved_at: string | null;
}

export interface AlertRuleItem {
    id: string;
    name: string;
    condition_type: string;
    threshold: number;
    window_minutes: number;
    severity: string;
    enabled: boolean;
}

// ─── Admin API ───

export const adminApi = {
    dashboard: (token: string) =>
        apiRequest<DashboardStats>("/admin/dashboard", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    events: (token: string, params?: { action?: string; user_id?: string; resource_type?: string; from_date?: string; to_date?: string; limit?: number; offset?: number }) => {
        const qs = new URLSearchParams();
        if (params?.action) qs.set("action", params.action);
        if (params?.user_id) qs.set("user_id", params.user_id);
        if (params?.resource_type) qs.set("resource_type", params.resource_type);
        if (params?.from_date) qs.set("from_date", params.from_date);
        if (params?.to_date) qs.set("to_date", params.to_date);
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.offset) qs.set("offset", String(params.offset));
        const q = qs.toString() ? `?${qs}` : "";
        return apiRequest<EventLogItem[]>(`/logs/events${q}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    securityLogs: (token: string, params?: { severity?: string; event_type?: string; from_date?: string; to_date?: string; limit?: number; offset?: number }) => {
        const qs = new URLSearchParams();
        if (params?.severity) qs.set("severity", params.severity);
        if (params?.event_type) qs.set("event_type", params.event_type);
        if (params?.from_date) qs.set("from_date", params.from_date);
        if (params?.to_date) qs.set("to_date", params.to_date);
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.offset) qs.set("offset", String(params.offset));
        const q = qs.toString() ? `?${qs}` : "";
        return apiRequest<SecurityLogItem[]>(`/logs/security${q}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    llmUsageLogs: (token: string, params?: { user_id?: string; model?: string; from_date?: string; to_date?: string; limit?: number; offset?: number }) => {
        const qs = new URLSearchParams();
        if (params?.user_id) qs.set("user_id", params.user_id);
        if (params?.model) qs.set("model", params.model);
        if (params?.from_date) qs.set("from_date", params.from_date);
        if (params?.to_date) qs.set("to_date", params.to_date);
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.offset) qs.set("offset", String(params.offset));
        const q = qs.toString() ? `?${qs}` : "";
        return apiRequest<LLMUsageLogItem[]>(`/logs/llm-usage${q}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    alerts: (token: string, params?: { status?: string; severity?: string }) => {
        const qs = new URLSearchParams();
        if (params?.status) qs.set("status", params.status);
        if (params?.severity) qs.set("severity", params.severity);
        const q = qs.toString() ? `?${qs}` : "";
        return apiRequest<AlertItem[]>(`/admin/alerts${q}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    },

    ackAlert: (token: string, alertId: string) =>
        apiRequest<{ message: string }>(`/admin/alerts/${alertId}/ack`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    resolveAlert: (token: string, alertId: string) =>
        apiRequest<{ message: string }>(`/admin/alerts/${alertId}/resolve`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }),

    alertRules: (token: string) =>
        apiRequest<AlertRuleItem[]>("/admin/alert-rules", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    updateAlertRule: (token: string, ruleId: string, data: { threshold?: number; window_minutes?: number; enabled?: boolean }) =>
        apiRequest<{ message: string }>(`/admin/alert-rules/${ruleId}`, {
            method: "PUT",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),

    alertStreamUrl: (token?: string) => {
        const base = `${API_BASE}/admin/alerts/stream`;
        return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },

    createInvite: (token: string, data: { role?: string; email?: string }) =>
        apiRequest<{ id: string; token: string; email: string | null; role: string; expires_at: string; message: string }>("/auth/invites", {
            method: "POST",
            body: JSON.stringify(data),
            headers: { Authorization: `Bearer ${token}` },
        }),
};
