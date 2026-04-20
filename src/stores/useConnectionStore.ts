import { create } from 'zustand';

type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ConnectionState {
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'closed',

  setStatus: (status) => set({ status }),
}));
