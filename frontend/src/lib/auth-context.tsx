"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { authApi, type LoginResponse, ApiRequestError, setTokenRefreshCallback } from "@/lib/api";

// ─── Types ───

interface User {
    id: string;
    email: string;
    full_name: string;
    role: string;
    roles?: string[];
    tenant_id: string;
}

interface AuthContextType {
    user: User | null;
    token: string | null;
    isLoading: boolean;
    login: (email: string, password: string, remember: boolean) => Promise<LoginResponse>;
    logout: () => Promise<void>;
    isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─── Storage helpers ───

const TOKEN_KEY = "access_token";
const USER_KEY = "user_data";

function getStored(key: string): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(key) || sessionStorage.getItem(key);
}

function setStored(key: string, value: string, persistent: boolean) {
    if (persistent) {
        localStorage.setItem(key, value);
    } else {
        sessionStorage.setItem(key, value);
    }
}

function clearStored(key: string) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
}

// ─── Provider ───

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const logoutRef = useRef<(() => Promise<void>) | null>(null);

    // Register the refresh callback so api.ts can update stored token on auto-refresh
    useEffect(() => {
        setTokenRefreshCallback((newToken: string) => {
            setToken(newToken);
            // Persist in whichever storage was used
            if (localStorage.getItem(TOKEN_KEY)) {
                localStorage.setItem(TOKEN_KEY, newToken);
            } else {
                sessionStorage.setItem(TOKEN_KEY, newToken);
            }
        });
    }, []);

    // Initialize from storage, then try silent refresh if HttpOnly cookie may exist
    useEffect(() => {
        const init = async () => {
            const savedToken = getStored(TOKEN_KEY);
            const savedUser = getStored(USER_KEY);

            if (savedToken && savedUser) {
                try {
                    setToken(savedToken);
                    setUser(JSON.parse(savedUser));
                } catch {
                    clearStored(TOKEN_KEY);
                    clearStored(USER_KEY);
                }
            } else {
                // No stored token — try silent refresh (HttpOnly cookie may still exist)
                try {
                    const resp = await authApi.refresh();
                    if (resp.access_token) {
                        setToken(resp.access_token);
                        setStored(TOKEN_KEY, resp.access_token, false);
                        // Fetch user profile with new token
                        try {
                            const me = await authApi.me(resp.access_token) as Record<string, string | string[] | undefined>;
                            const userData: User = {
                                id: me.id as string,
                                email: me.email as string,
                                full_name: me.full_name as string,
                                role: me.role as string,
                                roles: me.roles as string[] | undefined,
                                tenant_id: me.tenant_id as string,
                            };
                            setUser(userData);
                            setStored(USER_KEY, JSON.stringify(userData), false);
                        } catch {
                            // Token valid but can't fetch profile — still usable
                        }
                    }
                } catch {
                    // No valid session — user needs to login
                }
            }
            setIsLoading(false);
        };
        init();
    }, []);

    const login = useCallback(async (email: string, password: string, remember: boolean) => {
        const resp = await authApi.login({ email, password });

        const userData: User = {
            id: resp.user.id,
            email: resp.user.email,
            full_name: resp.user.full_name,
            role: resp.user.role,
            roles: resp.user.roles,
            tenant_id: resp.user.tenant_id,
        };

        setToken(resp.access_token);
        setUser(userData);
        setStored(TOKEN_KEY, resp.access_token, remember);
        setStored(USER_KEY, JSON.stringify(userData), remember);

        // Remember email if checked
        if (remember) {
            localStorage.setItem("remembered_email", email);
        } else {
            localStorage.removeItem("remembered_email");
        }

        return resp;
    }, []);

    const logout = useCallback(async () => {
        try {
            if (token) {
                await authApi.logout(token);
            }
        } catch {
            // Ignore errors during logout
        } finally {
            setToken(null);
            setUser(null);
            clearStored(TOKEN_KEY);
            clearStored(USER_KEY);
        }
    }, [token]);

    // Keep logoutRef current for external access
    logoutRef.current = logout;

    return (
        <AuthContext.Provider
            value={{
                user,
                token,
                isLoading,
                login,
                logout,
                isAuthenticated: !!token && !!user,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

// ─── Hook ───

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (ctx === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return ctx;
}

export { ApiRequestError };

