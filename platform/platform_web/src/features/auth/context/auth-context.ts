import { createContext } from 'react';
import type { DeploymentMode, User } from '../types';

export const AuthContext = createContext<{
  user: User | null;
  mode: DeploymentMode | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
} | null>(null);
