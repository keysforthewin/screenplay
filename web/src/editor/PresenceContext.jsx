import { createContext, useContext, useEffect, useState } from 'react';

const PresenceContext = createContext({
  users: [],
  setUsers: () => {},
  saveStatus: { state: 'idle', lastSaved: null },
  setSaveStatus: () => {},
});

export function PresenceProvider({ children }) {
  const [users, setUsers] = useState([]);
  const [saveStatus, setSaveStatus] = useState({ state: 'idle', lastSaved: null });
  return (
    <PresenceContext.Provider value={{ users, setUsers, saveStatus, setSaveStatus }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function useConnectedUsers() {
  return useContext(PresenceContext).users || [];
}

export function useSaveStatus() {
  return useContext(PresenceContext).saveStatus;
}

export function usePresenceSetters() {
  const { setUsers, setSaveStatus } = useContext(PresenceContext);
  return { setUsers, setSaveStatus };
}
