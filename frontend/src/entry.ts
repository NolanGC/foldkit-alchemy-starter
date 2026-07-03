import { Runtime } from 'foldkit'

import { overlay } from '@foldkit/devtools'

import { Model, Message, init, update, view } from './main'
import './styles.css'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root'),
  devTools: {
    overlay,
    Message,
  },
})

Runtime.run(application)
