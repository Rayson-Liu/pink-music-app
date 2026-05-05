import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UserState {
  user: {
    isLogin?: boolean;
    wbi_img?: {
      img_url?: string;
      sub_url?: string;
    };
  } | null;
}

interface Action {
  updateUser: (user: any) => void;
  clear: () => void;
}

export const useUser = create<UserState & Action>()(
  persist(
    set => ({
      user: null,
      updateUser: (user) => {
        set({ user });
      },
      clear: () => {
        set({ user: null });
      },
    }),
    {
      name: "user",
    },
  ),
);
