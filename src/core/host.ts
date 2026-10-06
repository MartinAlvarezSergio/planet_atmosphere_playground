import { ReactElement } from "react";

export type AppletHostAdapter = {
  onClose?: () => void;
  onResult?: (payload: Record<string, unknown>) => void;
  readReducedMotion?: () => boolean;
};

export type OpenAppletOptions = {
  host?: AppletHostAdapter;
};

export type OpenedApplet = {
  id: string;
  title: string;
  description: string;
  close: () => void;
  render: () => ReactElement;
};
