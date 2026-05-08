# Tuning Systems Catalog — Candidates for Built-in Patches

Curated list of tunings adjacent to (or in dialogue with) just intonation,
sized for our 12-oscillator cap. Each entry has the ratios/cents you'd
need to encode it as a `Patch` in `src/patches/builtins.js`, plus a
references block with a representative quote so the patches panel can
expand into "learn more" content.

Companion to `user-storage-architecture.md`. Written assuming the existing
schema where each ratio entry is `{ name, value, cents }` and `anchorHz`
gives the Hz of the 1/1.

## Note on quotations

Quotations from public-domain sources (Helmholtz/Ellis 1885, Boethius,
Werckmeister 1691, Kirnberger 1779) are given as best-effort verbatim or
near-verbatim, marked **[v]**. Quotations from modern copyrighted works
(Partch, Barbour, Jorgensen, Gann, etc.) are given as paraphrased
summaries marked **[p]** unless explicitly noted. **Verify against the
cited source before using in user-facing copy.** This catalog is
research-grade, not edited prose.

---

## 1. The 12-osc constraint

Wavetuner currently caps at 12 oscillators on desktop, 4 on mobile. The
WTP patch already uses all 12 desktop slots. So:

- **7-note diatonic patches** (Ptolemy, Pythagorean diatonic) are roomy
  — 7 notes leaves 5 slots free for the user to layer drones.
- **12-note chromatic patches** (12-TET, Pythagorean chromatic, meantone,
  well-temperaments) hit the cap exactly.
- **>12-note patches** (31-TET, Partch's 43-tone, Slendro+Pelog combined)
  don't fit and would require either subset selection or raising the cap.
  Treated as future work below.

For irrational tunings (everything that isn't pure JI) the `value` field
holds the float and `name` is a note name — the schema is fine with it,
no change needed.

---

## 2. Equal Temperament — 12-TET

The modern Western standard. The octave is divided into 12 equal
logarithmic steps; every adjacent semitone has the ratio `2^(1/12) ≈
1.05946`. Every interval except the octave is an irrational
approximation of the corresponding JI ratio. The major third (4 steps =
400¢) is **+13.69¢ sharp** of the pure 5/4 (386.31¢) — the most-noticed
difference when comparing 12-TET against JI on sustained tones.

**Anchor:** A4 = 440 Hz, 1/1 = A. This is the reference everyone tunes
to, and a comparison patch against JI is more meaningful with a shared A.

| n  | Note | Cents | Value (= 2^(n/12)) |
|----|------|-------|--------------------|
| 0  | A    | 0     | 1.0                |
| 1  | A♯   | 100   | 1.05946309435929   |
| 2  | B    | 200   | 1.12246204830937   |
| 3  | C    | 300   | 1.18920711500272   |
| 4  | C♯   | 400   | 1.25992104989487   |
| 5  | D    | 500   | 1.33483985417003   |
| 6  | D♯   | 600   | 1.41421356237310   |
| 7  | E    | 700   | 1.49830707687668   |
| 8  | F    | 800   | 1.58740105196820   |
| 9  | F♯   | 900   | 1.68179283050743   |
| 10 | G    | 1000  | 1.78179743628068   |
| 11 | G♯   | 1100  | 1.88774862536339   |

**References:**
- Hermann Helmholtz / Alexander J. Ellis, *On the Sensations of Tone as a Physiological Basis for the Theory of Music*, 4th ed. (London: Longmans, 1885), Pt. III Ch. XVI.
- J. Murray Barbour, *Tuning and Temperament: A Historical Survey* (Michigan State College Press, 1951), Ch. VIII ("Equal Temperament").
- Owen Jorgensen, *Tuning: Containing the Perfection of Eighteenth-Century Temperament, the Lost Art of Nineteenth-Century Temperament, and the Science of Equal Temperament* (Michigan State University Press, 1991).

> Helmholtz [p]: equal temperament is a compromise made unavoidable by the construction of keyboard instruments. He held that the ear "is far from regarding this temperament as the standard of correct intonation" — when given pure intervals, untrained listeners reliably prefer them, and the ear "feels the imperfections of equal temperament most distinctly when long sustained tones are heard."

> Barbour [p]: equal temperament was theorized by Zhu Zaiyu (China, 1584) and discussed in European treatises from the early 17th century onward, but only fully replaced earlier temperaments on European pianos around 1850.

---

## 3. 5-limit Just Intonation — Ptolemy's Intense Diatonic

The "vanilla" JI scale. Uses ratios built from primes 2, 3, and 5 — every
interval is a small-integer ratio, so the resulting consonances beat
hardly at all (which is why JI is so dramatic on sustained drones). 7
notes, octave-repeating.

This is the scale Helmholtz advocated and that most "JI for beginners"
material uses. In our context it's the cleanest comparison patch against
12-TET since it has the same note count + degree mapping but pure ratios.

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Ratio | Cents | Value (decimal) |
|------|-------|-------|-----------------|
| C    | 1/1   | 0.00     | 1.000000 |
| D    | 9/8   | 203.91   | 1.125000 |
| E    | 5/4   | 386.31   | 1.250000 |
| F    | 4/3   | 498.04   | 1.333333 |
| G    | 3/2   | 701.96   | 1.500000 |
| A    | 5/3   | 884.36   | 1.666667 |
| B    | 15/8  | 1088.27  | 1.875000 |

7 notes — 5 spare oscillator slots.

**References:**
- Klaudios Ptolemaios (Ptolemy), *Harmonics*, c. 150 CE; trans. Jon Solomon, *Ptolemy: Harmonics, Translation and Commentary* (Brill, 2000), Bk. I Chs. 14–16.
- Andrew Barker, *Greek Musical Writings, Vol. II: Harmonic and Acoustic Theory* (Cambridge: CUP, 1989), pp. 311–319 (on Ptolemy's tetrachord divisions).
- Helmholtz/Ellis, *Sensations of Tone*, Pt. III Chs. XII–XV (5-limit JI as the natural basis of Western consonance).

> Ptolemy (via Barker) [p]: of the various tetrachord divisions handed down by earlier Greek theorists — Archytas, Aristoxenus, Didymus — Ptolemy preferred the *syntonon diatonon* ("intense diatonic"), built from the ratios 16:15, 9:8, 10:9, because it best matched what trained singers actually sang and what the ear most readily recognized as melodic.

> Helmholtz [p]: "the natural relations of the tones of a major chord" follow the small-integer ratios 4:5:6 (root, third, fifth). Any deviation from these ratios produces audible beats, which the ear identifies as roughness. Ptolemy's diatonic preserves these relations across the full scale.

---

## 4. 5-limit Just Intonation Chromatic

Extends Ptolemy's diatonic to 12 chromatic notes using small-integer
5-limit ratios. The "Asymmetric Chromatic" or "Indian Just Chromatic"
arrangement is one of the most common; multiple slightly different
12-note 5-limit JI scales exist in the literature. The one below is
canonical (after Ben Johnston / Helmholtz):

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Ratio   | Cents   | Value     |
|------|---------|---------|-----------|
| C    | 1/1     | 0.00    | 1.000000  |
| C♯   | 16/15   | 111.73  | 1.066667  |
| D    | 9/8     | 203.91  | 1.125000  |
| E♭   | 6/5     | 315.64  | 1.200000  |
| E    | 5/4     | 386.31  | 1.250000  |
| F    | 4/3     | 498.04  | 1.333333  |
| F♯   | 45/32   | 590.22  | 1.406250  |
| G    | 3/2     | 701.96  | 1.500000  |
| G♯   | 8/5     | 813.69  | 1.600000  |
| A    | 5/3     | 884.36  | 1.666667  |
| B♭   | 9/5     | 1017.60 | 1.800000  |
| B    | 15/8    | 1088.27 | 1.875000  |

12 notes — fills the cap exactly.

**References:**
- Helmholtz/Ellis, *Sensations of Tone*, Pt. III Ch. XIV (the chromatic 5-limit table).
- Harry Partch, *Genesis of a Music*, 2nd ed. (Da Capo, 1974), Ch. 11 ("The Language of Ratios").
- Ben Johnston, *Maximum Clarity and Other Writings on Music*, ed. Bob Gilmore (University of Illinois Press, 2006) — collected essays on JI compositional practice.
- David B. Doty, *The Just Intonation Primer*, 3rd ed. (Just Intonation Network, 2002).

> Ben Johnston [p]: 12-tone JI is not a single canonical scale but a *family* of nearby scales. The chromatic notes can be read in different ways depending on context — a sharp can be a syntonic-comma raise of the diatonic note (75/64) or a different ratio entirely (25/24 above the tonic) — same name, different pitch. Composers writing in JI must decide each chromatic note's identity case by case.

> Partch [p]: the 5-limit chromatic scale represents only the "primary" subset of consonant ratios. Partch advocates extending to 11-limit ratios (involving the primes 7 and 11) to access the "subminor" and "supermajor" intervals that Western theory excluded but that the ear hears as consonant.

---

## 5. Pythagorean Diatonic

Strict 3-limit JI: every ratio is a power of 3/2 (and octave reductions
thereof). Uses primes 2 and 3 only. The major third is `81/64` (407.82¢)
— **wider** than both 12-TET (400¢) and 5-limit JI (386.31¢), with a
characteristic "bright" / pinging quality. The fifths are pure (701.96¢)
which gives the scale its strong perfect-cadence feel.

This is the tuning the medievals used. Worth shipping as a contrast
patch — directly answers "what does pure-fifth tuning sound like?"

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Ratio    | Cents    | Value    |
|------|----------|----------|----------|
| C    | 1/1      | 0.00     | 1.000000 |
| D    | 9/8      | 203.91   | 1.125000 |
| E    | 81/64    | 407.82   | 1.265625 |
| F    | 4/3      | 498.04   | 1.333333 |
| G    | 3/2      | 701.96   | 1.500000 |
| A    | 27/16    | 905.87   | 1.687500 |
| B    | 243/128  | 1109.78  | 1.898438 |

7 notes.

**References:**
- Boethius (Anicius Manlius Severinus Boethius), *De institutione musica*, c. 500 CE; trans. Calvin M. Bower, *Fundamentals of Music* (Yale University Press, 1989), Bks. I–II.
- Helmholtz/Ellis, *Sensations of Tone*, Pt. III Ch. XIII (on the Pythagorean third).
- Mark Lindley, "Pythagorean Intonation" in *Grove Music Online* (Oxford University Press, ongoing).
- Andrew Barker, *Greek Musical Writings, Vol. II*, Pt. 1 ("The Pythagoreans").

> Boethius [p, paraphrased from Bower's translation]: tracing the Pythagorean tradition back through Nicomachus, Boethius writes that consonance arises when two tones are related by a small whole-number ratio. The fifth (3:2), fourth (4:3), and octave (2:1) are *symphoniae* — the foundational consonances. The major third (81:64) is **not** counted as consonant in this tradition.

> Helmholtz [p]: the Pythagorean major third 81/64 sits 22¢ above the just 5/4 and is "decidedly too sharp for our modern ear" — heard against a sustained drone, it produces audible beats that the post-Renaissance ear has been trained to find rough.

---

## 6. Pythagorean Chromatic

Extends Pythagorean diatonic to 12 notes by going further up and down
the chain of fifths. Uses notes near both ends of the chain, so the
"wolf interval" (the leftover diminished sixth that doesn't close the
circle) lives between G♯ and E♭ — that's the historical baggage of pure
fifths.

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Ratio       | Cents    | Value    |
|------|-------------|----------|----------|
| C    | 1/1         | 0.00     | 1.000000 |
| C♯   | 2187/2048   | 113.69   | 1.067871 |
| D    | 9/8         | 203.91   | 1.125000 |
| E♭   | 32/27       | 294.13   | 1.185185 |
| E    | 81/64       | 407.82   | 1.265625 |
| F    | 4/3         | 498.04   | 1.333333 |
| F♯   | 729/512     | 611.73   | 1.423828 |
| G    | 3/2         | 701.96   | 1.500000 |
| G♯   | 6561/4096   | 815.64   | 1.601807 |
| A    | 27/16       | 905.87   | 1.687500 |
| B♭   | 16/9        | 996.09   | 1.777778 |
| B    | 243/128     | 1109.78  | 1.898438 |

12 notes.

**References:**
- Same primary sources as §5 (Boethius, Helmholtz, Lindley).
- Mark Lindley, "Pythagorean Intonation" in *Grove Music Online* — esp. on the historical placement of the wolf interval.
- J. Murray Barbour, *Tuning and Temperament*, Ch. II ("Pythagorean Tuning").

> Lindley [p]: Pythagorean tuning was the dominant scale of medieval European music through about 1450, when the rise of three-voice and four-voice polyphony with sweet thirds (in English discant practice and then continental polyphony) drove tuning practice toward meantone. The 12-note Pythagorean chromatic carries an unavoidable wolf fifth — historically placed between G♯ and E♭, where the chain of pure fifths fails to close the octave by the *Pythagorean comma* (≈23.46¢).

> Barbour [p]: Pythagorean tuning's strength is its three-limit purity — every fifth except the wolf is acoustically perfect — making it ideal for music whose harmonic vocabulary is restricted to fifths and fourths, as medieval organum and early Notre-Dame polyphony.

---

## 7. Quarter-Comma Meantone (Aron, 1523)

The dominant European keyboard tuning roughly 1500–1700, before well-
temperaments. The fifth is tempered narrow by 1/4 of the syntonic comma
(≈5.38¢) so that four stacked fifths equal a pure 5/4 major third. Result:
**every** major third is the JI 5/4 (386.31¢) — gorgeously pure — at the
cost of a "wolf fifth" (G♯–E♭) that's painfully out of tune.

The fifth becomes `5^(1/4) ≈ 1.495349` (696.578¢ vs JI's 701.96¢).

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Cents    | Value (= 2^(cents/1200)) |
|------|----------|--------------------------|
| C    | 0.00     | 1.000000 |
| C♯   | 76.05    | 1.044907 |
| D    | 193.16   | 1.118034 |
| E♭   | 310.26   | 1.196279 |
| E    | 386.31   | 1.250000 |
| F    | 503.42   | 1.337481 |
| F♯   | 579.47   | 1.397542 |
| G    | 696.58   | 1.495349 |
| G♯   | 772.63   | 1.561953 |
| A    | 889.74   | 1.671851 |
| B♭   | 1006.84  | 1.788854 |
| B    | 1082.89  | 1.869186 |

12 notes. The wolf fifth lives between G♯ and E♭ (737.64¢ — terrible).

**References:**
- Pietro Aron (Aaron), *Toscanello in Musica* (Venice: Bernardino & Mattheo de Vitali, 1523), Bk. II — first written description of meantone.
- Barbour, *Tuning and Temperament*, Ch. III ("Mean-Tone Temperaments").
- Mark Lindley, "Mean-tone" in *Grove Music Online*.
- Ross W. Duffin, *How Equal Temperament Ruined Harmony (and Why You Should Care)* (W.W. Norton, 2007) — popular-press defense of meantone for early-music performance.

> Aron [p, paraphrasing the Italian]: in *Toscanello*, Aron instructs the keyboard tuner to first sound the major third C–E "sonorous and just" (i.e., as a pure 5/4), then divide the four fifths C–G–D–A–E evenly so they reach exactly that third. He gives no quantitative description of the comma — just the audible target.

> Barbour [p]: 1/4-comma meantone became the standard European keyboard tuning from c. 1500 to c. 1700. It produces eight beautifully consonant major thirds at the cost of one painfully out-of-tune wolf fifth (G♯–E♭). Composers were expected to avoid keys that traversed the wolf, which is one reason Renaissance and early-Baroque keyboard music rarely modulates beyond a handful of "home" keys.

> Duffin [p]: meantone's pure thirds give early-music ensembles a *consonance* and *resonance* on sustained chords that ET cannot reach. The price is a restricted key vocabulary; the trade is well worth it for music written for that vocabulary.

---

## 8. Werckmeister III (1691)

The most famous of the well-temperaments — the ones Bach probably used.
A "circular" temperament: all 12 keys are playable but each has a
slightly different character (some closer to JI, some closer to ET).
Eight fifths are pure 3/2; four are tempered narrow by 1/4 of the
Pythagorean comma to close the circle and absorb the wolf.

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Cents      | Value    |
|------|------------|----------|
| C    | 0.000      | 1.000000 |
| C♯   | 90.225     | 1.053497 |
| D    | 192.180    | 1.117647 |
| E♭   | 294.135    | 1.184913 |
| E    | 390.225    | 1.252982 |
| F    | 498.045    | 1.333333 |
| F♯   | 588.270    | 1.404663 |
| G    | 696.090    | 1.494927 |
| G♯   | 792.180    | 1.580539 |
| A    | 888.270    | 1.670436 |
| B♭   | 996.090    | 1.777778 |
| B    | 1092.180   | 1.879441 |

12 notes. Very close to JI in the "home" keys C/F/G; gradually warmer
in distant keys like F♯/D♭.

**References:**
- Andreas Werckmeister, *Musicalische Temperatur* (Quedlinburg: Theodor Philipp Calvisius, 1691).
- Owen Jorgensen, *Tuning the Historical Temperaments by Ear* (Northern Michigan University Press, 1977).
- Barbour, *Tuning and Temperament*, Ch. IX ("Irregular Systems").
- Bradley Lehman, "Bach's Extraordinary Temperament" (*Early Music* 33, no. 1, Feb. 2005, pp. 3–23) — for the broader debate about which temperament Bach's WTC actually called for.

> Werckmeister [p, original German]: in his preface to the *Musicalische Temperatur*, Werckmeister advocates a temperament in which "all the keys are usable, but each retains its own colour" — explicitly rejecting both the wolf-bearing meantones of his day (which restricted the usable key vocabulary) and the bland uniformity of equal temperament (which some of his contemporaries already proposed but which he found unmusical because it erased *Tonartencharakter*, "key character").

> Jorgensen [p]: Werckmeister III is constructed by tempering four fifths (C–G, G–D, D–A, B–F♯) narrow by a quarter of the Pythagorean comma each; the remaining eight fifths are pure. The result places the closest-to-just thirds in the home keys C, F, G and gradually wider thirds in remote keys, giving each key a distinct flavour without making any unusable.

---

## 9. Kirnberger III (1779)

Another well-temperament, contemporary with late Bach. Slightly
different distribution of comma reductions than Werckmeister; one pure
JI third (C–E) lives in the home key, the rest gradient toward ET as
keys move further around the circle. Kirnberger considered this the
"correct" tuning for Bach's WTC.

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Cents      | Value    |
|------|------------|----------|
| C    | 0.000      | 1.000000 |
| C♯   | 90.225     | 1.053497 |
| D    | 193.157    | 1.118034 |
| E♭   | 294.135    | 1.184913 |
| E    | 386.314    | 1.250000 |
| F    | 498.045    | 1.333333 |
| F♯   | 590.224    | 1.406250 |
| G    | 696.578    | 1.495349 |
| G♯   | 792.180    | 1.580539 |
| A    | 889.735    | 1.671851 |
| B♭   | 996.091    | 1.777778 |
| B    | 1088.269   | 1.875000 |

12 notes. C major / G major sound nearly JI; F♯ major sits closer to ET.

**References:**
- Johann Philipp Kirnberger, *Die Kunst des reinen Satzes in der Musik* ("The Art of Strict Musical Composition") (Berlin & Königsberg, 1771–1779), 2 vols.
- Barbour, *Tuning and Temperament*, Ch. IX.
- Joel Lester, *Compositional Theory in the Eighteenth Century* (Harvard University Press, 1992) — context on Kirnberger's theoretical position.
- Bradley Lehman, "Bach's Extraordinary Temperament" (*Early Music* 33, 2005).

> Kirnberger [p, original German]: a student of J.S. Bach, Kirnberger insisted that any usable keyboard temperament must preserve at least one acoustically pure 5/4 major third — the "home" third in C major. His third temperament places that pure third on C–E and absorbs the syntonic comma elsewhere in the chain. He held equal temperament to be unfit for music of any expressive depth precisely because it erases the distinctness between keys.

> Barbour [p]: Kirnberger III differs from Werckmeister III mainly in **where** the comma is distributed — Kirnberger pushes more of the impurity onto a single fifth (D–A, narrow by one syntonic comma) so the rest of the circle stays close to pure. The result is a slightly more polarized "home vs. distant key" feel than Werckmeister.

---

## 10. Vallotti (≈ 1779)

Perhaps the most "balanced" historical well-temperament. Six fifths
(F–C–G–D–A–E–B) are tempered narrow by 1/6 Pythagorean comma; the other
six are pure. Symmetrical, simple to encode, and very smooth across all
keys — closer to ET than Werckmeister but with enough JI flavor to hear
the difference on sustained drones.

**Anchor:** C4 = 261.6256 Hz, 1/1 = C.

| Note | Cents      | Value    |
|------|------------|----------|
| C    | 0.000      | 1.000000 |
| C♯   | 94.135     | 1.056008 |
| D    | 196.090    | 1.120311 |
| E♭   | 298.045    | 1.187851 |
| E    | 392.180    | 1.255881 |
| F    | 501.955    | 1.336337 |
| F♯   | 592.180    | 1.408258 |
| G    | 698.045    | 1.498212 |
| G♯   | 796.090    | 1.583951 |
| A    | 894.135    | 1.674762 |
| B♭   | 1000.000   | 1.781797 |
| B    | 1090.225   | 1.877123 |

12 notes. A reasonable ship-as-default well-temperament if we only
include one.

**References:**
- Francesco Antonio Vallotti, *Della Scienza Teorica e Pratica della Moderna Musica* (manuscript, c. 1779; first published Padua: Premiata Libreria Antoniana, 1950).
- Mark Lindley, "Well-tempered Clavier" and "Vallotti, Francesco Antonio" in *Grove Music Online*.
- Barbour, *Tuning and Temperament*, Ch. IX.
- Owen Jorgensen, *Tuning*, §§ on Vallotti and the eighteenth-century well-temperaments.

> Lindley [p]: Vallotti's temperament — six fifths (F–C–G–D–A–E–B) tempered narrow by 1/6 of the Pythagorean comma each, the other six pure — is the most evenly distributed of the historical well-temperaments. It is the modern default tuning for performances of unspecified-temperament Baroque keyboard repertoire and the most common choice for harpsichords and historical organs in current concert practice.

> Jorgensen [p]: where Werckmeister III concentrates the comma in four fifths and Kirnberger III concentrates more of it in just one or two, Vallotti spreads it across six. The smoother distribution gives every key a milder character than Werckmeister and Kirnberger — keys feel related, but not identical, the way modulations in Mozart and Haydn assume.

---

## 11. La Monte Young — Well-Tuned Piano *(already shipped)*

Listed for completeness. 12 notes, anchored at D♯4 = 297.9894 Hz so
A lands on 440. See `builtins.js` for the ratios. 7-limit JI with
septimal characters (7/4, 49/32, 567/512, etc.) — wildly different
from any of the above and a striking listen back-to-back with WTP's
chromatic peers in this list.

**References:**
- Kyle Gann, "La Monte Young's *The Well-Tuned Piano*" (*Perspectives of New Music*, Vol. 31, No. 1, Winter 1993, pp. 134–162) — definitive analysis of the work's tuning system and structure.
- La Monte Young, liner notes to *The Well-Tuned Piano 81 X 25 6:17:50–11:18:59 PM NYC*, Gramavision 18-8701-2 (1987) — Young's own notes on the tuning, recorded performance from 1981.
- Bob Gilmore, "Changing the Metaphor: Ratio Models of Musical Pitch in the Work of Harry Partch, Ben Johnston, and James Tenney" (*Perspectives of New Music*, Vol. 33, No. 1/2, 1995, pp. 458–503) — situates Young alongside other JI composers.
- Jeremy Grimshaw, *Draw a Straight Line and Follow It: The Music and Mysticism of La Monte Young* (Oxford University Press, 2011) — full biographical/theoretical context.

> Kyle Gann [p]: *The Well-Tuned Piano* is a 5+ hour solo piano work — Young has performed it on a single Bösendorfer Imperial tuned to his own 7-limit just intonation scale rooted on E♭. The septimal intervals (7/4, 7/6, 21/16, 49/32) produce overtone-series resonances impossible in equal temperament. Young calls the resulting sustained sonorities "harmonic clouds." Each section of the piece is a chord-region named after a god, demon, or natural phenomenon — "The Magic Chord," "The Brontosaurus Cadenza," "The Romantic Chord."

> Young (Gramavision liner notes, 1987) [p]: Young describes the tuning as derived from prime-number relationships up to 7, chosen so that A would land on 440 Hz with E♭ as 1/1 — anchoring the work in the standard concert pitch while basing every interval on small-integer ratios that the 12-tone equal-tempered piano cannot approach.

---

## 12. Future / out-of-cap candidates

These don't fit the 12-osc cap and would need either subset curation or
a cap raise. Worth knowing about:

- **31-TET** — 31 equal divisions of the octave (≈38.7¢ steps). Very
  close to extended quarter-comma meantone; the "JI lover's equal
  temperament." Could ship a 12-note subset.
- **53-TET** — 53 equal divisions, near-perfect approximation of 5-limit
  JI in every key. Subset only.
- **Harry Partch's 43-tone JI** — 11-limit, specifically Partch's own
  scale. Would need a curated 12-note subset (e.g. his "primary" notes).
- **Bohlen-Pierce** — 13 equal divisions of the **tritave** (3:1, 1902¢)
  rather than the octave. Schema-incompatible: our `applyPatch` assumes
  octave-equivalent ratios, and BP doesn't repeat at 2:1. Would need
  schema work to support non-octave patches.
- **Slendro / Pelog (Javanese)** — 5-tone (slendro) and 7-tone (pelog)
  Indonesian gamelan tunings. Anywhere from "5 roughly-equal" to
  highly-irregular depending on which gamelan ensemble. Easy to fit (<12
  notes); the hard part is choosing a canonical version since each
  ensemble's tuning is unique.
- **Wendy Carlos's Alpha / Beta / Gamma** — non-octave equal temperaments
  (α = 78¢ steps, β = 63.8¢, γ = 35.1¢). Same schema issue as BP.

---

## 13. Schema fit + encoding guidance

The current schema (`PATCH_SCHEMA = wavetuner.patch.v1`) handles all
the 12-or-fewer-note octave-repeating tunings above without changes:

```js
{
  schema: PATCH_SCHEMA,
  id: 'builtin_<slug>',
  name: '...',
  author: '...',
  description: '...',
  source: 'builtin',
  createdAt: '...',
  updatedAt: '...',
  ratios: [
    { name: 'C',   value: 1.0,        cents: 0 },
    { name: 'C♯',  value: 1.0594631,  cents: 100 },
    // ...
  ],
  anchorHz: 261.6256,    // C4
  rootMidi: 60,          // optional, MIDI pitch class of 1/1
}
```

For irrational ratios (12-TET, meantone, well-temperaments), compute the
`value` from cents: `value = 2 ** (cents / 1200)`. Either store the
literal `2 ** (cents / 1200)` expression (build-time-evaluated by the
JS engine — readable), or use the precomputed decimals from the tables
above.

Pre-stamp the `cents` field too so the patch panel's preview list
doesn't have to recompute it from `Math.log2(value)` for every render
— minor but free correctness.

---

## 14. Recommended starter set

If you want to keep the panel manageable and ship a curated few rather
than all of them, my recommendation is **5 built-ins** (plus the
existing Default + WTP = 7 total):

1. **12-TET** — the universal reference, especially for JI/ET A-B.
2. **5-limit JI Diatonic (Ptolemy)** — clean, classic JI.
3. **Pythagorean Chromatic** — pure-fifth chromatic, foundationally
   different from #2.
4. **Quarter-comma Meantone** — pure JI thirds at the cost of one wolf,
   the historical pre-temperament.
5. **Vallotti** — the smoothest well-temperament; covers the
   well-temperament category without committing to a specific Bach
   denomination.

Skipping Werckmeister III and Kirnberger III isn't a hard call — they're
similar enough to Vallotti that hearing one is enough for most users;
power users can build them by hand from the cents tables here.

If you want **fewer**, drop to: 12-TET + Ptolemy + Pythagorean Chromatic
+ Quarter-comma. That's 4 patches covering the tuning-systems landscape.

If you want **more**, add Werckmeister III (most-historically-loaded
well-temperament) and 5-limit JI Chromatic (rounds out the JI set).

---

## 15. Source notes

Cents values for historical temperaments come from the standard
references — Barbour (*Tuning and Temperament: A Historical Survey*,
1951) and Jorgensen (*Tuning*, 1991). Where sources disagree by a few
hundredths of a cent (different rounding conventions), I've used the
values that round to the cleaner expressions in commas-of-fifths math.
For Werckmeister III specifically there are two slightly different
historical specifications floating around; I used the more common
"Werckmeister III (correct temperament)" set from Werckmeister's 1691
*Musicalische Temperatur*.

5-limit JI ratios are unambiguous (small integers); cents derived as
`1200 * log2(ratio)`.

12-TET values are exact (`2^(n/12)`).
