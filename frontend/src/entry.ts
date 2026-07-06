import { Runtime } from "foldkit";

import { overlay } from "@foldkit/devtools";

import {
  ChangedUrl,
  ClickedLink,
  Flags,
  Model,
  Message,
  flags,
  init,
  managedResources,
  subscriptions,
  update,
  view,
} from "./main";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => ClickedLink({ request }),
    onUrlChange: (url) => ChangedUrl({ url }),
  },
  devTools: {
    overlay,
    Message,
  },
});

Runtime.run(application);
