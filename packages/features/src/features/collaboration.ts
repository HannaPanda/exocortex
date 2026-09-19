import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Working together, what happened before, and what the agents remember. */
export const COLLABORATION_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'echtzeit',
    area: 'zusammenarbeit',
    title: 'Wer gerade mitliest, und wo',
    summary:
      'Oben rechts stehen die Leute, die dieselbe Seite offen haben, und ihre Schreibmarke ist im Text zu sehen. Fällt die Verbindung aus, schreibst du weiter und die Änderungen laufen beim Wiederverbinden zusammen.',
    details: [
      'Über dem Editor stehen kleine Kreise für alle, die dieselbe Seite offen haben. Im Text siehst du ihre Schreibmarke in ihrer Farbe, mitsamt Namen, und ihre Markierung, wenn sie etwas auswählen. Damit weißt du, ob jemand gerade an demselben Absatz sitzt, bevor ihr euch gegenseitig im Weg steht.',
      'Getippt wird gleichzeitig, ohne Sperren und ohne Konfliktkopien. Bricht die Verbindung ab, schreibst du im Browser weiter; beim Wiederverbinden werden beide Stände zusammengeführt. Ein kleiner Hinweis sagt dir, wenn die Verbindung weg ist, damit du nicht rätst.',
      'Die Anwesenheit läuft über eine andere Leitung als der Text selbst. Das ist der Grund, warum ein Ausfall der einen Seite die andere nicht mitreißt: du kannst weiterschreiben, auch wenn gerade niemandes Kreis zu sehen ist.',
    ],
    since: '2026-08-05',
    references: ['ADR-004', 'ADR-008'],
    ui: { where: 'Die Kreise oben rechts über dem Editor.' },
  }),
  defineFeature({
    id: 'kommentare',
    area: 'zusammenarbeit',
    title: 'Kommentare an einer Textstelle',
    summary:
      'Ein Kommentar hängt an der markierten Stelle und wandert mit ihr mit, wenn der Text darüber wächst. Ein Gespräch lässt sich als erledigt markieren, statt gelöscht zu werden.',
    details: [
      'Du markierst eine Stelle im Text, klickst auf das Sprechblasen-Symbol in der Auswahlleiste und schreibst. Die Stelle bleibt farbig hinterlegt, ein Klick darauf öffnet den Faden. Antworten hängen darunter, sodass aus einem Kommentar ein Gespräch wird und nicht fünf einzelne Notizen.',
      'Der Anker liegt am Text selbst, nicht an einer Zeilennummer. Schreibt jemand drei Absätze darüber, bleibt der Kommentar an seinem Satz. Wird der Satz gelöscht, bleibt der Kommentar als nicht mehr verankert erhalten, statt still zu verschwinden.',
      'Erledigt heißt erledigt und nicht weg: ein abgeschlossener Faden verschwindet aus dem Text, bleibt aber in der Liste im Kontextbereich rechts (Strg+Punkt) lesbar. Agenten können Kommentare schreiben, lesen und abschließen, was der übliche Weg ist, auf dem eine Automation ihr Ergebnis hinterlässt, ohne den Text anzufassen.',
    ],
    since: '2026-08-05',
    ui: { where: 'Text markieren, dann das Sprechblasen-Symbol; Liste im Kontextbereich rechts.' },
    shortcuts: ['Strg+. öffnet den Kontextbereich'],
    tools: [
      'exo_comment_create',
      'exo_comment_list',
      'exo_comment_update',
      'exo_comment_resolve',
      'exo_comment_delete',
    ],
  }),
  defineFeature({
    id: 'verlauf',
    area: 'zusammenarbeit',
    title: 'Versionen zurückholen',
    summary:
      'Vor jedem Schreibvorgang von außen und in regelmäßigen Abständen beim Tippen entsteht ein Schnappschuss. Der Aktivitätsbereich listet sie mit Zeit und Urheber, und ein Klick stellt einen davon wieder her.',
    details: [
      'Zwei Dinge lösen einen Schnappschuss aus: jeder Schreibvorgang, der nicht aus dem Editor kommt, also jeder Zugriff eines Agenten oder einer Automation, und eine Schreibsitzung im Editor, die in Abständen gesichert wird. Der erste Fall ist der wichtige, denn dort ändert etwas die Seite, während du nicht hinschaust.',
      'Im Kontextbereich rechts liegt der Reiter "Aktivität" mit der Liste: wann, von wem, aus welchem Anlass. Ein Klick stellt diesen Stand wieder her, und weil das Wiederherstellen selbst eine Änderung ist, entsteht dabei erneut ein Schnappschuss. Du kannst also auch ein Zurückrollen zurückrollen.',
      'Wie lange die Stände aufgehoben werden, ist einstellbar, in zwei Stufen: eine Weile lang alle, danach einer pro Tag. Das hält die Datenbank klein, ohne dass die Geschichte einer Seite mit einem Schlag verschwindet.',
    ],
    since: '2026-08-09',
    ui: { where: 'Der Reiter "Aktivität" im Kontextbereich rechts.' },
    settings: [
      'activity.editSessionSnapshotsEnabled',
      'activity.snapshotRetentionFullDays',
      'activity.snapshotRetentionDailyDays',
    ],
    tools: ['exo_page_activity', 'exo_page_snapshots', 'exo_page_restore_snapshot'],
  }),
  defineFeature({
    id: 'versionsvergleich',
    area: 'zusammenarbeit',
    title: 'Sehen, was sich geändert hat',
    summary:
      'Zwei Stände einer Seite lassen sich nebeneinanderlegen: was dazugekommen ist, was weg ist, was umgeschrieben wurde, Wort für Wort. Einzelne Blöcke holst du daraus zurück, ohne die ganze Seite zurückzusetzen.',
    details: [
      'Im Reiter "Aktivität" ist die Liste nach Tagen gruppiert, und ein Klick auf einen gespeicherten Stand öffnet den Vergleich. Verglichen wird gegen den aktuellen Inhalt der Seite oder gegen einen zweiten Stand. Das Ergebnis liest sich von oben nach unten wie die Seite selbst: unveränderte Blöcke sind zusammengeklappt, geänderte zeigen den alten und den neuen Text mit den einzelnen Wörtern hervorgehoben.',
      'Verglichen wird blockweise, anhand der festen Kennung, die jeder Block trägt. Deshalb steht bei einem verschobenen Absatz "verschoben" und nicht "gelöscht und neu geschrieben". Die Einheit ist der Block auf oberster Ebene: ändert sich ein Punkt einer Liste, gilt die Liste als geändert und der Wortvergleich zeigt darin, welcher Punkt es war.',
      'Aus dem Vergleich holst du einzelne Blöcke zurück. Der alte Stand entscheidet dabei: stand der Block dort, wird er wieder in die Seite geschrieben, notfalls an seinem alten Platz zwischen den Nachbarn, die es noch gibt; stand er dort nicht, wird er aus der Seite genommen. Alles andere auf der Seite bleibt, wie es ist, auch das, was nach dem Schnappschuss entstanden ist. Vorher entsteht wieder ein Schnappschuss, das Zurückholen selbst ist also auch zurückholbar.',
    ],
    since: '2026-09-19',
    ui: {
      where:
        'Der Reiter "Aktivität" im Kontextbereich rechts: ein Klick auf einen Stand vergleicht, ' +
        'das Menü daneben trägt Vergleichen und Wiederherstellen.',
    },
    tools: ['exo_page_snapshot_diff', 'exo_page_restore_blocks'],
  }),
  defineFeature({
    id: 'agenten-journal',
    area: 'zusammenarbeit',
    title: 'Was ein Agent in einer Sitzung geändert hat',
    summary:
      'Schreibvorgänge eines Agenten werden zu einer Sitzung gebündelt und im Journal festgehalten, jeweils mit dem Schnappschuss von vor der Änderung. Damit lässt sich nachlesen, was ein Lauf angefasst hat, und einzelne Seiten gezielt zurückrollen.',
    details: [
      'Ein Agent meldet beim Verbinden eine Sitzungskennung an und trägt sie danach bei jedem Aufruf mit. Alles, was in dieser Sitzung geschrieben wird, hängt damit zusammen: "diese acht Seiten hat Claude Code heute früh angefasst" ist eine Frage mit einer Antwort, statt acht einzelner Einträge in acht Seitenverläufen.',
      'Jeder Eintrag zeigt Seite, Zeitpunkt, Werkzeug und den Schnappschuss von vor der Änderung. Er zeigt nicht, was geschrieben wurde: das Journal verweist auf den Stand davor, statt Inhalt zu kopieren, damit es nicht zu einer zweiten, ungeschützten Ablage deiner Texte wird.',
      'Zurückgerollt wird pro Seite, über das gewöhnliche Wiederherstellen eines Schnappschusses. Einen Knopf "ganze Sitzung zurücknehmen" gibt es bewusst nicht: wo jemand nach dem Agenten weitergeschrieben hat, wäre das Ergebnis ein halber Rückbau, der so aussieht, als wäre er vollständig.',
    ],
    since: '2026-09-13',
    references: ['ADR-022'],
    ui: { where: 'Verwaltung, Bereich Agenten.' },
    settings: ['agents.journalRetentionDays'],
    tools: ['exo_agent_session_list', 'exo_agent_session_get'],
    claims: { screens: ['/admin/agenten'] },
  }),
  defineFeature({
    id: 'agenten-gedaechtnis',
    area: 'gedaechtnis',
    title: 'Ein Gedächtnis, das die Agenten selbst führen',
    summary:
      'Claude Code, Hermes und andere Clients legen ihre Sitzungsnotizen in einem eigenen Arbeitsbereich ab und bekommen sie beim nächsten Mal zum passenden Verzeichnis zurück. Das ist bewusst vom kuratierten Wissen getrennt: Mitschrieb darf aufgeräumt und verworfen werden.',
    details: [
      'Am Ende einer Sitzung legt der Client eine verdichtete Notiz ab, beim nächsten Start bekommt er die Notizen zurück, die zum Arbeitsverzeichnis passen. Damit weiß eine frische Sitzung, was letzte Woche entschieden wurde, ohne dass du es noch einmal erzählst. Mit den Hooks des Claude-Code-Plugins passiert das von selbst.',
      'Das Gedächtnis ist ein eigener Arbeitsbereich, den du in seinen Einstellungen dazu erklärst. Die Trennung ist der Kern: kuratiertes Wissen schreibt ein Mensch, weil es das wert ist, Mitschrieb entsteht automatisch und darf jederzeit aufgeräumt oder weggeworfen werden. Ein automatischer Mitschrieb gehört deshalb nie in den kuratierten Bereich.',
      'Gespeichert wird eine Verdichtung, nie das rohe Gespräch. Die Notizen sind gewöhnliche Seiten, also lesbar, durchsuchbar, änderbar und löschbar wie alles andere, und was ein Agent darf, entscheidet seine Mitgliedschaft im Arbeitsbereich und nicht sein Token.',
    ],
    since: '2026-08-12',
    references: ['ADR-019', 'ADR-023'],
    ui: { where: 'Ein Arbeitsbereich wird in seinen Einstellungen zum Gedächtnis erklärt.' },
    settings: ['memory.enabled', 'memory.captureModelSlug', 'memory.retentionDays'],
    tools: ['recall', 'remember'],
  }),
  defineFeature({
    id: 'gedaechtnis-fakten',
    area: 'gedaechtnis',
    title: 'Verdichtete Fakten über den Notizen',
    summary:
      'Aus vielen Sitzungsnotizen destilliert ein nächtlicher Lauf einzelne Aussagen, die über den Notizen stehen und bei jedem Abruf zuerst kommen. Eine Aussage, die niemand mehr bestätigt, verliert langsam an Gewicht, und ein Widerspruch wird markiert statt aufgelöst.',
    details: [
      'Fünfzig Sitzungsnotizen sind kein Gedächtnis, sondern ein Stapel. Ein nächtlicher Lauf liest sie und zieht einzelne Aussagen heraus: "der MCP-Bezeichner lautet …", "die Anmeldung läuft über …". Diese Fakten stehen über den Notizen und kommen bei jedem Abruf zuerst, weil sie kurz und geprüft sind.',
      'Jeder Faktum trägt, wie oft und wann er zuletzt bestätigt wurde. Bestätigt ihn eine Weile niemand mehr, sinkt sein Gewicht langsam, statt dass eine Notiz nach Ablauf eines Datums verschwindet. Widersprechen sich zwei Aussagen, wird das markiert und nicht nach Mehrheit entschieden, denn die neuere ist nicht automatisch die richtige.',
      'Auf der Seite "Gedächtnis" siehst du die Fakten mit ihrer Herkunft und kannst nachlesen, aus welchen Notizen einer stammt. Ein Faktum ins kuratierte Wissen zu heben, bleibt ein bewusster Schritt von dir; das entscheidet kein Lauf.',
    ],
    since: '2026-09-08',
    references: ['ADR-021'],
    ui: { where: 'Die Seite "Gedächtnis" in der Navigation.', path: '/gedaechtnis' },
    settings: [
      'memory.consolidationEnabled',
      'memory.factHalfLifeDays',
      'memory.factConfidenceFloor',
    ],
    tools: ['exo_memory_facts', 'exo_memory_fact_promote'],
    claims: { screens: ['/gedaechtnis'] },
  }),
  defineFeature({
    id: 'entitaeten',
    area: 'gedaechtnis',
    title: 'Personen, Orte und Dinge über Seiten hinweg',
    summary:
      'Eine Entität ist eine Zeile in einer Datenbank, die ihre Schreibweisen kennt. Taucht eine davon in einer Seite auf, wird die Seite mit ihr verknüpft, und das Profil sammelt alles, was über sie geschrieben wurde. Wiederkehrende, noch unbekannte Namen werden als Kandidaten vorgeschlagen.',
    details: [
      'Eine Entität ist eine Zeile in einer dafür bestimmten Datenbank, also wieder eine Seite. Sie kennt ihren Namen und ihre anderen Schreibweisen: "Dr. Meier", "Meier", "H. Meier". Taucht eine davon in einer Seite auf, wird die Seite mit der Entität verknüpft, ohne dass jemand einen Verweis setzen muss.',
      'Das Profil zeigt danach alles an einem Ort: die Seite der Entität selbst, jede Seite, die sie erwähnt, und die Verweise auf andere Entitäten. So wird aus verstreuten Notizen die Frage "was weiß ich eigentlich über diese Person" mit einer Antwort.',
      'Namen, die immer wieder vorkommen, aber noch keine Entität sind, werden als Kandidaten vorgeschlagen; du bestätigst oder verwirfst sie. Relationen sind gewöhnliche Verweise zwischen Zeilen, kein eigenes Modell, und kein Modell entscheidet von sich aus, dass zwei Namen dieselbe Person sind.',
    ],
    since: '2026-09-08',
    references: ['#47'],
    ui: { where: 'Die Seite "Entitäten" in der Navigation.', path: '/entitaeten' },
    settings: ['entities.enabled', 'entities.databaseId', 'entities.candidatesEnabled'],
    tools: [
      'exo_entity_create',
      'exo_entity_update',
      'exo_entity_list',
      'exo_entity_profile',
      'exo_entity_link_page',
      'exo_entity_unlink_page',
      'exo_entity_candidates',
      'exo_entity_candidate_confirm',
      'exo_entity_candidate_dismiss',
    ],
    claims: { screens: ['/entitaeten'] },
  }),
];
