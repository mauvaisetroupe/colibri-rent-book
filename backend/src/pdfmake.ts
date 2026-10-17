import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import pdfmake from 'pdfmake'

// pdfmake, set up once for every document of the server (supporting documents, minutes): the font (Roboto) comes with
// pdfmake, the same rendering everywhere; no other file, no download.

const polices = join(dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'fonts', 'Roboto')
pdfmake.setFonts({
  Roboto: {
    normal: join(polices, 'Roboto-Regular.ttf'),
    bold: join(polices, 'Roboto-Medium.ttf'),
    italics: join(polices, 'Roboto-Italic.ttf'),
    bolditalics: join(polices, 'Roboto-MediumItalic.ttf'),
  },
})
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy((path: string) => path.startsWith(polices))

export default pdfmake
