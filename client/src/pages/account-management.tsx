import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Plus, Users, LogOut } from "lucide-react";
import { useLocation } from "wouter";

import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { SessionInfo } from "@shared/schema";

interface WhatsAppAccount {
  sessionId: string;
  name: string;
  number: string;
  status: 'connected' | 'disconnected' | 'qr_required' | 'connecting';
  loginTime: string;
}

export default function AccountManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  
  // Track loading states for different actions per account
  const [loadingStates, setLoadingStates] = useState<{
    [sessionId: string]: {
      logout?: boolean;
      relogin?: boolean;
      delete?: boolean;
      activate?: boolean;
    };
  }>({});
  
  // Helper functions to manage loading states
  const setAccountLoading = (sessionId: string, action: string, isLoading: boolean) => {
    setLoadingStates(prev => ({
      ...prev,
      [sessionId]: {
        ...prev[sessionId],
        [action]: isLoading
      }
    }));
  };
  
  const isAccountLoading = (sessionId: string, action: string): boolean => {
    return loadingStates[sessionId]?.[action] || false;
  };

  // Fetch all WhatsApp accounts
  const { data: accountsData, isLoading: accountsLoading } = useQuery<{accounts: WhatsAppAccount[]}>({
    queryKey: ['/api/accounts'],
    refetchInterval: 5000, // Poll every 5 seconds
    staleTime: 3000, // Cache for 3 seconds
  });

  // Fetch QR code for adding new accounts
  const { data: qrData, isLoading: qrLoading } = useQuery<{qr?: string | null}>({
    queryKey: ['/api/get-qr'],
    enabled: showAddAccount, // Only enabled when adding account
    refetchInterval: showAddAccount ? 5000 : false, // Poll when adding account
    staleTime: 3000, // Cache QR for 3 seconds
  });

  // Fetch system status - less frequent updates
  const { data: systemStatus } = useQuery<{client: string; puppeteer: string; storage: string; lastCheck: string}>({
    queryKey: ['/api/system-status'],
    refetchInterval: 60000, // Update every 60 seconds
    staleTime: 50000, // Cache for 50 seconds
  });

  // Get active account (first connected account by default)
  const allAccounts = accountsData?.accounts || [];
  
  // Filter out dummy accounts (disconnected accounts with empty names/numbers)
  const accounts = allAccounts.filter((account: WhatsAppAccount) => {
    // Show account if it has a valid name and number, or if it's connected
    return (account.name && account.name.trim() !== '' && account.number && account.number.trim() !== '') || 
           account.status === 'connected';
  });
  
  const connectedAccounts = accounts.filter(acc => acc.status === 'connected');
  const disconnectedAccounts = accounts.filter(acc => acc.status === 'disconnected');
  
  // Set default active account to first connected account
  useEffect(() => {
    if (connectedAccounts.length > 0 && !activeAccount) {
      const savedActive = localStorage.getItem('activeWhatsAppAccount');
      if (savedActive && connectedAccounts.find(acc => acc.sessionId === savedActive)) {
        setActiveAccount(savedActive);
      } else {
        setActiveAccount(connectedAccounts[0].sessionId);
      }
    }
  }, [connectedAccounts, activeAccount]);

  // Logout mutation for specific account
  const logoutMutation = useMutation({
    mutationFn: (sessionId: string) => {
      setAccountLoading(sessionId, 'logout', true);
      return apiRequest(`/api/accounts/${sessionId}/logout`, 'POST');
    },
    onSuccess: (_, sessionId) => {
      // Refresh accounts list
      queryClient.invalidateQueries({ queryKey: ['/api/accounts'] });
      
      // If active account was logged out, switch to next available
      if (activeAccount === sessionId) {
        const remaining = connectedAccounts.filter(acc => acc.sessionId !== sessionId);
        if (remaining.length > 0) {
          setActiveAccount(remaining[0].sessionId);
        } else {
          setActiveAccount(null);
        }
      }
      
      setAccountLoading(sessionId, 'logout', false);
      toast({
        title: "Success",
        description: "Account logged out successfully",
      });
    },
    onError: (error: any, sessionId) => {
      setAccountLoading(sessionId, 'logout', false);
      toast({
        title: "Error",
        description: "Failed to logout account",
        variant: "destructive",
      });
    },
  });

  // Relogin mutation for specific account
  const reloginMutation = useMutation({
    mutationFn: (sessionId: string) => {
      setAccountLoading(sessionId, 'relogin', true);
      return apiRequest(`/api/accounts/${sessionId}/relogin`, 'POST');
    },
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['/api/accounts'] });
      setAccountLoading(sessionId, 'relogin', false);
      toast({
        title: "Success",
        description: "Account relogin initiated",
      });
    },
    onError: (error: any, sessionId) => {
      setAccountLoading(sessionId, 'relogin', false);
      toast({
        title: "Error",
        description: "Failed to relogin account",
        variant: "destructive",
      });
    },
  });

  // Delete mutation for specific account
  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => {
      setAccountLoading(sessionId, 'delete', true);
      return apiRequest(`/api/accounts/${sessionId}`, 'DELETE');
    },
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['/api/accounts'] });
      setAccountLoading(sessionId, 'delete', false);
      toast({
        title: "Success",
        description: "Account deleted successfully",
      });
    },
    onError: (error: any, sessionId) => {
      setAccountLoading(sessionId, 'delete', false);
      toast({
        title: "Error",
        description: "Failed to delete account",
        variant: "destructive",
      });
    },
  });

  const handleLogout = (sessionId: string) => {
    logoutMutation.mutate(sessionId);
  };

  const handleRelogin = (sessionId: string) => {
    reloginMutation.mutate(sessionId);
  };

  const handleDelete = (sessionId: string) => {
    deleteMutation.mutate(sessionId);
  };

  // Mutation to set active account on backend
  const setActiveAccountMutation = useMutation({
    mutationFn: (sessionId: string) => {
      setAccountLoading(sessionId, 'activate', true);
      return apiRequest('/api/active-account', 'POST', { sessionId });
    },
    onSuccess: (data, sessionId) => {
      setActiveAccount(sessionId);
      localStorage.setItem('activeWhatsAppAccount', sessionId);
      
      // Refresh data for the new active account
      queryClient.invalidateQueries({ queryKey: ['/api/chats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'] });
      
      setAccountLoading(sessionId, 'activate', false);
      toast({
        title: "Account Activated",
        description: `Switched to ${accounts.find(acc => acc.sessionId === sessionId)?.name || 'account'}`,
      });
    },
    onError: (error: any, sessionId) => {
      setAccountLoading(sessionId, 'activate', false);
      toast({
        title: "Error",
        description: "Failed to activate account",
        variant: "destructive",
      });
    },
  });

  const handleActivateAccount = (sessionId: string, isActive: boolean) => {
    if (isActive) {
      setActiveAccountMutation.mutate(sessionId);
    }
  };

  const handleAddAccount = () => {
    setShowAddAccount(true);
  };

  const handleCancelAddAccount = () => {
    setShowAddAccount(false);
  };

  const getInitials = (name: string) => {
    return name.charAt(0).toUpperCase();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return `${date.toLocaleDateString()}, ${date.toLocaleTimeString()}`;
  };

  return (
    <div className="bg-background font-sans min-h-screen">
      {/* Header */}
      <header className="bg-surface shadow-sm border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <svg className="w-8 h-8 text-green-500 mr-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893A11.821 11.821 0 0020.893 3.506z"/>
              </svg>
              <h1 className="text-xl font-semibold text-foreground">WhatsApp Web Automation</h1>
            </div>
            <nav className="flex items-center space-x-4">
              <Button variant="ghost" size="sm">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Button>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Users className="h-6 w-6 text-muted-foreground" />
            <h1 className="text-2xl font-bold text-foreground">WhatsApp Accounts</h1>
          </div>
          <Button onClick={handleAddAccount} className="flex items-center space-x-2">
            <Plus className="h-4 w-4" />
            <span>Add Account</span>
          </Button>
        </div>
        
        <p className="text-muted-foreground mb-8">Manage multiple WhatsApp accounts from a unified dashboard</p>

        {/* Show QR code when adding new account */}
        {showAddAccount && (
          <Card className="mb-6">
            <CardContent className="p-8">
              <div className="text-center">
                <h2 className="text-xl font-semibold mb-4">Scan QR Code to Add Account</h2>
                {qrData?.qr && (
                  <div className="mb-4">
                    <img
                      src={qrData.qr.startsWith('data:') ? qrData.qr : `data:image/png;base64,${qrData.qr}`}
                      alt="QR Code for WhatsApp Authentication"
                      className="w-64 h-64 mx-auto rounded-xl border"
                      loading="lazy"
                    />
                  </div>
                )}
                <Button variant="outline" onClick={handleCancelAddAccount}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Connected Accounts */}
        {connectedAccounts.length > 0 && (
          <div className="space-y-4 mb-8">
            {connectedAccounts.map((account) => (
              <Card key={account.sessionId} className="relative">
                <CardContent className="p-6">
                  <div className="flex items-center space-x-4">
                    <Avatar className="w-12 h-12">
                      <AvatarFallback className="bg-green-500 text-white text-lg font-bold">
                        {getInitials(account.name)}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-foreground">{account.name}</h3>
                      <div className="flex items-center space-x-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <span className="text-sm text-green-600">Connected</span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Connected: {formatDate(account.loginTime)}
                      </p>
                    </div>

                    {/* Activation Switch - only for connected accounts */}
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-2">
                        <Switch
                          checked={activeAccount === account.sessionId}
                          onCheckedChange={(checked) => handleActivateAccount(account.sessionId, checked)}
                          disabled={activeAccount === account.sessionId || isAccountLoading(account.sessionId, 'activate')} // Prevent deactivating the active account
                        />
                        <span className="text-sm text-muted-foreground">
                          {activeAccount === account.sessionId ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleLogout(account.sessionId)}
                        disabled={isAccountLoading(account.sessionId, 'logout')}
                        className="hover:bg-red-50 hover:border-red-300 hover:text-red-600"
                      >
                        {isAccountLoading(account.sessionId, 'logout') ? (
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-300 border-t-red-600"></div>
                        ) : (
                          <LogOut className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Disconnected Accounts - No switches shown */}
        {disconnectedAccounts.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-muted-foreground">Disconnected Accounts</h2>
            {disconnectedAccounts.map((account) => (
              <Card key={account.sessionId} className="opacity-60">
                <CardContent className="p-6">
                  <div className="flex items-center space-x-4">
                    <Avatar className="w-12 h-12">
                      <AvatarFallback className="bg-gray-400 text-white text-lg font-bold">
                        {account.name ? getInitials(account.name) : '?'}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-foreground">
                        {account.name || 'Disconnected Account'}
                      </h3>
                      <div className="flex items-center space-x-2">
                        <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                        <span className="text-sm text-gray-500">Disconnected</span>
                      </div>
                      {account.loginTime && (
                        <p className="text-sm text-muted-foreground">
                          Last connected: {formatDate(account.loginTime)}
                        </p>
                      )}
                    </div>

                    {/* Action buttons for disconnected accounts */}
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRelogin(account.sessionId)}
                        disabled={isAccountLoading(account.sessionId, 'relogin')}
                        className="text-blue-600 hover:bg-blue-50 hover:border-blue-300"
                      >
                        {isAccountLoading(account.sessionId, 'relogin') ? (
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600"></div>
                        ) : (
                          'Relogin'
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(account.sessionId)}
                        disabled={isAccountLoading(account.sessionId, 'delete')}
                        className="text-red-600 hover:bg-red-50 hover:border-red-300"
                      >
                        {isAccountLoading(account.sessionId, 'delete') ? (
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-300 border-t-red-600"></div>
                        ) : (
                          'Delete'
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* No accounts message */}
        {accounts.length === 0 && !accountsLoading && (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold text-foreground mb-2">No WhatsApp Accounts</h2>
              <p className="text-muted-foreground mb-6">
                Add your first WhatsApp account to get started with bulk messaging
              </p>
              <Button onClick={handleAddAccount} className="flex items-center space-x-2 mx-auto">
                <Plus className="h-4 w-4" />
                <span>Add Account</span>
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
