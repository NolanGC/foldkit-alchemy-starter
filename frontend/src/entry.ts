import { Runtime } from "foldkit";

import { Model, init, update, view } from "./main";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
});

Runtime.run(application);
