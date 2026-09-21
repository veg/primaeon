/**
 * xml.js — an XML document read into the shape `xml.etree.ElementTree` hands `parse_beast_xml`,
 * with the entity, depth and size policy this app owns rather than inherits.
 *
 * WHY THIS FILE EXISTS. `parse_beast_xml` (hyphaeon/dataset.py:84-233) is written against
 * ElementTree and reads exactly seven things from it: `root.tag`, `root.attrib`, `root.iter()` in
 * document order, `findall('.//tag')`, `find('./tag')`, `element.text` and — the one that decides
 * which parsers can be used at all — `element.tail`, because dataset.py:145 reads a
 * `<taxon idref="A"/>` child's TAIL as the sequence of `<sequence><taxon idref="A"/>ACGT</sequence>`.
 * `beast.js` is the port of that function; this file is the half that turns bytes into nodes, and
 * it holds NO BEAST knowledge and NO date rule, so every structural guard in
 * `date-ingestion.test.js` applies to it unchanged.
 *
 * WHAT IT COSTS. saxes + xmlchars is 2 packages and 264 KB on disk; bundled alone with esbuild it
 * is 28,738 bytes minified and 8,146 gzipped, and the whole reader (saxes + this file + `beast.js`)
 * is 44,071 / 14,574. It rides into the published `@veg/hyphaeon-mcp`, and it reaches the browser
 * through `@veg/hyphaeon-runtime/dates`, which the `/time` route already imports.
 *
 * WHY A DEPENDENCY, AND WHY THIS ONE. Node 22.22.0 has no global `DOMParser` (measured:
 * `typeof DOMParser === 'undefined'`) and the browser's would then give two behaviours for one
 * input, which the port rules forbid. `saxes` 6.0.0 (ISC, pinned exactly in `runtime/package.json`)
 * is the one parser in reach that is STRICT about well-formedness, carries no Node builtins (its
 * only dependency is `xmlchars`, which is data tables), and exposes namespaces in a form that
 * reproduces ElementTree's `{uri}local` tag names. It costs 2 packages and 264 KB on disk
 * (measured: `du -sk node_modules/saxes node_modules/xmlchars` = 168 + 96), and it rides into the
 * published `@veg/hyphaeon-mcp`. The alternative already in the tree, `fast-xml-parser` 5.11.1
 * (web-only, via phylotree), is not well-formedness-strict: MEASURED on a 2,000-sequence BEAST
 * document cut at an element boundary, it returns 973 of the 2,000 sequences with NO error, where
 * this reader refuses the same bytes ("unclosed tag: alignment") — a corrupt upload silently
 * becoming a short dataset and a wrong dating analysis. Its separate `XMLValidator.validate` does
 * catch that file, but a validator that has to be remembered is not a guarantee. saxes's last publish is 2022-05-17; it is jsdom's XML parser, has no npm
 * advisory, and this file uses four of its events, so replacing it later is contained.
 *
 * THE ENTITY POLICY IS OURS, NOT THE PARSER'S. saxes has no DTD support at all: `parser.ENTITIES`
 * starts as the five predefined XML entities and every other reference is a hard error. That alone
 * makes XXE impossible — nothing is ever fetched or opened — but it would also REFUSE a legitimate
 * hand-edited BEAST 1 file, which the reference accepts (measured: `<!ENTITY taxonA "SeqAlpha">`
 * gives ElementTree the taxon name `SeqAlpha`). So the internal subset is read here and general
 * internal entities are installed, while:
 *   - an EXTERNAL entity (`SYSTEM`/`PUBLIC`) is recorded and NOT installed, so a reference to it
 *     fails as an undefined entity exactly as the reference fails it (measured: ElementTree raises
 *     "reference to external entity in attribute" on both a `file://` and an `http://` entity, and
 *     a canary HTTP server and file read recorded ZERO hits on both sides);
 *   - a DOCTYPE that merely DECLARES an external subset it never uses is parsed, not refused,
 *     because the reference parses it (measured: `external_dtd_unused.xml`, ok, 1 sequence);
 *   - every entity RESOLUTION is charged against `XML_LIMITS.maxEntityChars`. Charging
 *     declarations instead of resolutions is the bug the probe found: the quadratic document
 *     declares ONE 100 KB entity (inside any declaration budget) and references it 10,000 times,
 *     which produced a V8 "Invalid string length" crash rather than a refusal. Charging
 *     resolutions refuses it at 1,100,000 charged characters, and refuses the billion-laughs
 *     document at its third level. ElementTree refuses both too, as expat's "limit on input
 *     amplification factor (from DTD and entities) breached" (measured).
 *
 * THE THREE LIMITS THAT ARE OURS ALONE, with the measurement behind each, taken with THIS reader.
 *   - `maxDepth` (512). Namespace resolution under saxes's `xmlns: true` is O(depth) per element,
 *     so nesting is quadratic. Measured on one `<n>` chain with the cap lifted: 1,000 deep 21 ms,
 *     5,000 deep 111 ms, 20,000 deep 1,427 ms, 50,000 deep 9,877 ms — and that last document is
 *     342 KiB of text. ElementTree reads the same 50,000-deep file in 37.8 ms and ACCEPTS it, so
 *     this cap is a DIVERGENCE from the reference, taken deliberately: real BEAST XML nests under
 *     30, and a browser worker must not be hangable by a third of a megabyte.
 *   - `maxChars` (16,777,216 = 16 MiB). This is a ceiling, not a cliff: measured, a 98-taxon H5N1
 *     BEAST 1 document (182,695 chars) parses in 6.3 ms against the reference's own 2.1 ms, and a
 *     5,000-taxon by 3,000-site document of 14.75 MiB parses in 58 ms (91 ms through the whole
 *     port) for an RSS delta under 10 MB, because a node holds substrings of the input rather than
 *     copies. 16 MiB is the cap for a BROWSER DROP, which has no other; the MCP and the server cap
 *     their own text fields at 8 MiB independently, and a caller who sends an alignment beside the
 *     XML pays for both against that.
 *   - `maxWork` (64,000,000 units). SIZE AND SHAPE ARE NOT COST. `maxChars` bounds the bytes and
 *     `maxDepth` bounds the nesting, but NOTHING bounded the work the port then does OVER that
 *     shape, and `parse_beast_xml` is quadratic in nesting depth by construction: dataset.py:123
 *     collects every `<alignment>` and `<data>` in the document and dataset.py:126 then runs a
 *     DESCENDANT search from each one, so a chain of alignment elements nested inside one another
 *     makes every ancestor re-read the whole subtree below it, sequences and all.
 *
 *     MEASURED, every row min-of-N in ONE process against the SAME document, this reader before
 *     the fix and after it. "Before" is the recursive `yield*` walk with no budget; every row it
 *     accepted was under `maxChars` AND under `maxDepth`, so nothing already here refused any of
 *     them. `<alignment>` nested `depth` deep with the sequences at the bottom:
 *
 *         document                       chars     before      after   work units
 *         H5N1 BEAST 1, 98 x 1698      179,403     1.6 ms     1.5 ms      183,728   0.29%
 *         FilteredAlignment 500x3000 1,516,492     7.7 ms     8.2 ms    3,078,076   4.81%
 *         BEAST 2, 5,000 x 3,000    15,232,869    74.4 ms    67.0 ms   15,503,957  24.22%
 *         nested d=50,  20 x 400         9,975     2.9 ms     1.1 ms      483,284   0.76%
 *         nested d=100, 20 x 400        11,125    10.8 ms     2.0 ms      975,584   1.52%
 *         nested d=200, 20 x 400        13,425    53.7 ms     4.5 ms    1,990,184   3.11%
 *         nested d=500, 20 x 400        20,325   622.5 ms    10.2 ms    5,273,984   8.24%
 *         nested d=500, 60 x 2,000     133,965   960.3 ms   105.5 ms   62,795,904  98.12%
 *         nested d=500, 100 x 30,000 3,015,605  3,589.0 ms  118.6 ms      REFUSED
 *         nested d=500, 500 x 30,000 15,032,405 16,998.6 ms 155.5 ms      REFUSED
 *         visit bomb, d=509            571,756   (see below) 757.5 ms     REFUSED
 *         flat 16 MiB of `<a/>`     16,777,203  5,411.8 ms 2,261.7 ms     REFUSED
 *
 *     Fourteen megabytes of well-formed, shallow-enough, small-enough XML for SEVENTEEN SECONDS of
 *     a browser worker or of a server job thread, from a file a reader can paste.
 *
 *     TWO INDEPENDENT CHANGES MADE THAT TABLE. The first is that `iterElements` and
 *     `findAllDescendants` below walk an explicit stack instead of a `yield*` chain: a `yield*`
 *     chain costs O(depth) per element YIELDED, so the old reader paid the document's depth again
 *     on every element anyone looked at, and that alone took depth 500 from 622.5 ms to 10.2 ms
 *     with no refusal involved. The second is this budget, which refuses the documents no traversal
 *     can make cheap. The worst case the OLD reader had was not the big one above at all — measured
 *     on a 509-deep chain whose bottom is N `<x/>` elements, it spent 3,874 ms on 15,756 characters,
 *     7,167 on 19,756, 13,839 on 27,756, 27,074 on 43,756 and 54,979 on 75,756, where this reader
 *     spends 27 / 23 / 39 / 69 / 165 ms. The 571,756-character version of that shape was never run
 *     to completion on the old reader; here it is refused in 757.5 ms.
 *
 *     THE BOUND IS ON WORK, in units where one unit is one character of element text the port
 *     normalises and one element visit is `VISIT_UNITS` of them (see there for why they are not the
 *     same price). Both halves matter and neither alone is enough. MEASURED by lifting the budget
 *     and reading the meter: the 14.3 MiB document re-normalises 7,500,000,000 CHARACTERS while
 *     visiting 884,256 elements, so a node-visit cap set anywhere a real file could pass would have
 *     let it straight through — and with the budget lifted the rewritten traversal still takes
 *     19.1 s on it, which is the proof that the stack walk alone does not close this. The visit
 *     bomb is the mirror image: 571,756 characters of document, of which 2,036 are sequence, and
 *     16,000,000 element visits. Neither has more than 509 alignment nodes — a plausible partition
 *     count — so no cap on the NUMBER of `<alignment>`/`<data>` elements catches either one.
 *
 *     64,000,000 is four times `maxChars`, and the factor is what a LEGITIMATE document can need:
 *     the port makes six full passes over the element tree (the `spec` scan, `alignment`, `data`,
 *     `taxon`, `trait`, the starting-tree walk) plus one descendant search per alignment node, and
 *     BEAST 2's `FilteredAlignment` legitimately nests `<data>` inside `<data>`, so a real file
 *     costs about `2 x its characters + 7 x VISIT_UNITS x its elements`. The three legitimate rows
 *     above spend 0.29%, 4.81% and 24.22% of it. HALVING IT WOULD REFUSE a 16 MiB
 *     `FilteredAlignment`, which is why it is not halved.
 *
 *     WHAT IT DOES NOT DO. It bounds AMPLIFICATION, not the linear cost of a large upload. The most
 *     expensive document it ADMITS costs about 64 M units, which is ~105 ms when they are characters
 *     and ~760 ms when they are element visits. What it cannot make fast is the PARSE: 16 MiB of
 *     `<a/>` is 4,194,300 elements, and building them is 1.9 s before any traversal runs (that row
 *     is refused, but only after saxes has already done its work). Lowering that means lowering
 *     `maxChars`, not this. See `runtime/test/beast-xml.test.js`, where every row above is a test.
 *
 * WHAT IS DELIBERATELY NOT HERE. No XPath beyond the three forms `parse_beast_xml` uses
 * (`.//tag`, `./tag`, `iter()`), no serialisation, no mutation, no `.gz`: every entry point in
 * this directory takes TEXT the caller already read (`index.js`'s header, asserted by the NO
 * FILESYSTEM guard), so a gzipped upload is inflated by the surface before it arrives.
 */

import { SaxesParser } from 'saxes';

/**
 * The five numbers this reader refuses on. Each is a judgement backed by the measurement in the
 * header; they are exported so a surface can print the limit it hit rather than the word "large".
 */
export const XML_LIMITS = Object.freeze({
	/** Characters of XML text. 16 MiB; see the header for the memory measurement. */
	maxChars: 16 * 1024 * 1024,
	/** Open elements. 512; BEAST XML nests under 30 and namespace resolution is O(depth). */
	maxDepth: 512,
	/** Characters an entity table may hand back in total, charged per RESOLUTION. 1 MiB. */
	maxEntityChars: 1024 * 1024,
	/** How deep one entity value may reference another while being resolved. */
	maxEntityDepth: 20,
	/**
	 * Units of work one document read may cost, where a unit is ONE element visited by a traversal
	 * or ONE character of element text normalised. 4x `maxChars`; see the header for the shape that
	 * made size and depth alone insufficient, and for the two measurements that set the factor.
	 */
	maxWork: 64 * 1000 * 1000
});

/** The reasons a document is refused. `'malformed'` is the parser's own verdict. */
export const XML_REFUSALS = Object.freeze([
	'malformed',
	'too_large',
	'too_deep',
	'entity_expansion',
	'entity_depth',
	'too_much_work'
]);

/**
 * A refusal with the parser's own coordinates. `reason` is an `XML_REFUSALS` member so a caller
 * classifies without reading the sentence; `message` is the sentence a person reads.
 */
export class XmlReadError extends Error {
	/**
	 * @param {string} message
	 * @param {{reason: string, line?: number|null, column?: number|null}} info
	 */
	constructor(message, info) {
		super(message);
		this.name = 'XmlReadError';
		this.reason = info.reason;
		this.line = info.line ?? null;
		this.column = info.column ?? null;
	}
}

/**
 * @typedef {{tag: string, attrib: Record<string,string>, text: string, tail: string,
 *   children: XmlElement[]}} XmlElement
 */

/**
 * @typedef {{root: XmlElement, elements: number, depth: number, namespaced: boolean,
 *   doctype: string|null,
 *   entities: {declared: string[], external: string[], parameter: string[],
 *     parameterReferenced: boolean, resolvedChars: number}}} XmlDocument
 */

/** ElementTree names a namespaced element `{uri}local`; an unqualified one keeps its bare name. */
function etName(uri, local) {
	return uri ? `{${uri}}${local}` : local;
}

/** The XML namespace of `xmlns=` / `xmlns:x=` declarations, which ElementTree drops from `attrib`. */
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';

/**
 * Read the internal subset of a DOCTYPE into a general-entity table.
 *
 * A hand scan, not a regular expression, because an entity value may contain `>`: the declaration
 * ends at the first `>` OUTSIDE a quoted value. Parameter entities (`<!ENTITY % p "...">`) are
 * recorded and NOT installed — a non-validating parser does not expand them in content, and the
 * reference's own behaviour when one is referenced is measured in `beast.js`'s divergence list.
 *
 * @param {string} subset the text between `[` and `]` of the DOCTYPE
 * @returns {{general: Map<string,string>, external: string[], parameter: string[],
 *   parameterReferenced: boolean}}
 */
function readInternalSubset(subset) {
	/** @type {Map<string,string>} */
	const general = new Map();
	/** @type {string[]} */
	const external = [];
	/** @type {string[]} */
	const parameter = [];
	let parameterReferenced = false;

	for (let i = 0; i < subset.length; i++) {
		if (subset[i] === '%' && /[A-Za-z_:]/.test(subset[i + 1] ?? '')) {
			// A parameter-entity REFERENCE inside the subset. Recorded so `beast.js` can say why a
			// document the reference reads (emptily) is refused here.
			parameterReferenced = true;
			continue;
		}
		if (!subset.startsWith('<!ENTITY', i)) continue;
		let j = i + '<!ENTITY'.length;
		const readSpace = () => {
			while (j < subset.length && /\s/.test(subset[j])) j++;
		};
		readSpace();
		let isParameter = false;
		if (subset[j] === '%') {
			isParameter = true;
			j++;
			readSpace();
		}
		const nameStart = j;
		while (j < subset.length && !/[\s>]/.test(subset[j])) j++;
		const name = subset.slice(nameStart, j);
		readSpace();
		let value = null;
		let isExternal = false;
		if (subset[j] === '"' || subset[j] === "'") {
			const quote = subset[j];
			const end = subset.indexOf(quote, j + 1);
			if (end < 0) {
				// Unterminated: leave it undefined and let the parser fail on the reference, which is
				// what the reference does with a malformed subset too.
				break;
			}
			value = subset.slice(j + 1, end);
			j = end + 1;
		} else if (subset.startsWith('SYSTEM', j) || subset.startsWith('PUBLIC', j)) {
			isExternal = true;
		}
		// Advance to the end of the declaration, ignoring `>` inside quotes.
		let quote = '';
		while (j < subset.length) {
			const c = subset[j];
			if (quote) {
				if (c === quote) quote = '';
			} else if (c === '"' || c === "'") {
				quote = c;
			} else if (c === '>') {
				break;
			}
			j++;
		}
		i = j;
		if (!name) continue;
		if (isParameter) parameter.push(name);
		else if (isExternal) external.push(name);
		else if (value !== null) general.set(name, value);
	}
	return { general, external, parameter, parameterReferenced };
}

/**
 * Expand `&name;` references inside declared entity values, depth-bounded.
 * ElementTree's parser does this too; doing it here keeps a legitimate nested declaration working
 * while the budget below keeps a bomb from ever being built.
 *
 * @param {Map<string,string>} general
 * @returns {Map<string,string>}
 */
function resolveEntityValues(general) {
	const PREDEFINED = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
	const cache = new Map();
	const expand = (name, depth, seen) => {
		if (cache.has(name)) return cache.get(name);
		if (depth > XML_LIMITS.maxEntityDepth || seen.has(name)) {
			throw new XmlReadError(
				`Entity '${name}' references itself, or nests more than ${XML_LIMITS.maxEntityDepth} deep.`,
				{ reason: 'entity_depth' }
			);
		}
		const raw = general.get(name);
		if (raw === undefined) return null;
		seen.add(name);
		const out = raw.replace(/&([A-Za-z_:][\w.:-]*);/g, (whole, ref) => {
			if (Object.prototype.hasOwnProperty.call(PREDEFINED, ref)) return PREDEFINED[ref];
			const nested = expand(ref, depth + 1, seen);
			return nested === null ? whole : nested;
		});
		seen.delete(name);
		if (out.length > XML_LIMITS.maxEntityChars) {
			throw new XmlReadError(
				`Entity '${name}' expands to ${out.length} characters; the limit is ${XML_LIMITS.maxEntityChars}.`,
				{ reason: 'entity_expansion' }
			);
		}
		cache.set(name, out);
		return out;
	};
	const resolved = new Map();
	for (const name of general.keys()) {
		const value = expand(name, 0, new Set());
		if (value !== null) resolved.set(name, value);
	}
	return resolved;
}

/**
 * Parse an XML document into ElementTree-shaped nodes.
 *
 * @param {string} text the document, already decoded and inflated by the surface
 * @param {{fileName?: string, limits?: Partial<typeof XML_LIMITS>}} [options]
 * @returns {XmlDocument}
 * @throws {XmlReadError} on a malformed document or a limit
 */
export function parseXmlDocument(text, options = {}) {
	const limits = { ...XML_LIMITS, ...(options.limits ?? {}) };
	// A leading byte-order mark is legal in a UTF-8 file and is not part of the document. Python's
	// reader is handed the same character and tolerates it (measured: `bom_crlf.xml`, 1 sequence).
	let body = String(text ?? '');
	if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

	if (body.length > limits.maxChars) {
		throw new XmlReadError(
			`The XML is ${body.length} characters; the limit is ${limits.maxChars}.`,
			{ reason: 'too_large' }
		);
	}

	const parser = new SaxesParser({ xmlns: true, fileName: options.fileName ?? 'the XML' });

	/** @type {XmlElement|null} */
	let root = null;
	/** @type {XmlElement[]} */
	const stack = [];
	let elements = 0;
	let deepest = 0;
	let namespaced = false;
	let doctype = null;
	let resolvedChars = 0;
	/** @type {{declared: string[], external: string[], parameter: string[], parameterReferenced: boolean}} */
	let entityInfo = { declared: [], external: [], parameter: [], parameterReferenced: false };

	parser.on('doctype', (dt) => {
		doctype = String(dt);
		const open = doctype.indexOf('[');
		const close = doctype.lastIndexOf(']');
		if (open < 0 || close < open) return;
		const read = readInternalSubset(doctype.slice(open + 1, close));
		const resolved = resolveEntityValues(read.general);
		entityInfo = {
			declared: Array.from(resolved.keys()),
			external: read.external,
			parameter: read.parameter,
			parameterReferenced: read.parameterReferenced
		};
		const table = parser.ENTITIES;
		for (const [name, value] of resolved) table[name] = value;
		// Charge every RESOLUTION, not every declaration: see the header for the measurement that
		// made the difference between a refusal and a V8 "Invalid string length" crash.
		parser.ENTITIES = new Proxy(table, {
			get(target, key) {
				const value = Reflect.get(target, key);
				if (typeof value === 'string') {
					resolvedChars += value.length;
					if (resolvedChars > limits.maxEntityChars) {
						throw new XmlReadError(
							`The document's entities expand to more than ${limits.maxEntityChars} characters.`,
							{ reason: 'entity_expansion', line: parser.line, column: parser.column }
						);
					}
				}
				return value;
			}
		});
	});

	parser.on('opentag', (node) => {
		/** Attacker-controlled names are dictionary keys here: a taxon literally called `__proto__`
		 *  silently lost its date through a plain `{}` in the probe, so every map in this reader and
		 *  in `beast.js` is prototype-free. */
		const attrib = Object.create(null);
		for (const key of Object.keys(node.attributes)) {
			const attr = node.attributes[key];
			// ElementTree drops namespace DECLARATIONS from `attrib`; keeping them would put a `spec`
			// -free document one `xmlns:spec` away from reading as BEAST 2.
			if (attr.uri === XMLNS_URI || attr.name === 'xmlns') continue;
			if (attr.uri) namespaced = true;
			attrib[etName(attr.uri, attr.local)] = attr.value;
		}
		if (node.uri) namespaced = true;
		/** @type {XmlElement} */
		const el = { tag: etName(node.uri, node.local), attrib, text: '', tail: '', children: [] };
		elements++;
		if (stack.length > 0) stack[stack.length - 1].children.push(el);
		else if (root === null) root = el;
		stack.push(el);
		if (stack.length > deepest) deepest = stack.length;
		if (stack.length > limits.maxDepth) {
			throw new XmlReadError(
				`The XML nests more than ${limits.maxDepth} elements deep.`,
				{ reason: 'too_deep', line: parser.line, column: parser.column }
			);
		}
	});

	const addText = (chunk) => {
		const current = stack[stack.length - 1];
		if (!current) return; // whitespace and comments outside the root element
		if (current.children.length === 0) current.text += chunk;
		else current.children[current.children.length - 1].tail += chunk;
	};
	parser.on('text', addText);
	parser.on('cdata', addText);

	parser.on('closetag', () => {
		stack.pop();
	});

	try {
		parser.write(body).close();
	} catch (err) {
		if (err instanceof XmlReadError) throw err;
		const message = err?.message ?? String(err);
		const at = /:(\d+):(\d+):/.exec(message);
		throw new XmlReadError(message, {
			reason: 'malformed',
			line: at ? Number(at[1]) : null,
			column: at ? Number(at[2]) : null
		});
	}

	if (root === null) {
		throw new XmlReadError('The XML has no root element.', { reason: 'malformed' });
	}

	return {
		root,
		elements,
		depth: deepest,
		namespaced,
		doctype,
		entities: { ...entityInfo, resolvedChars }
	};
}

// =================================================================================================
// The work budget: the bound on what a document COSTS, which its size and its shape do not give
// =================================================================================================

/**
 * @typedef {{spent: number, max: number}} WorkBudget a mutable meter shared by one document read
 */

/**
 * What one ELEMENT VISIT costs, in the units a character of normalised text costs one of.
 *
 * The two are not the same price and a meter that pretended they were would be wrong by more than
 * an order of magnitude. MEASURED with this reader, on the two documents in the header's table that
 * sit right at the budget: the depth-500 x 2,000-base one spends 62.8 M units in 105.5 ms and is
 * character-dominated, so a unit is ~1.7 ns there; the 509-deep visit bomb is refused after 16 M
 * VISITS in 757.5 ms, so a visit is ~47 ns. That is a ratio near 28, and it is consistent with the
 * ordinary-case micro-benchmark of the normalisation itself (106.9 ns for a 4-base sequence,
 * 314.8 ns for 400 bases, 13.8 us for 30,000: ~0.46 ns per character above a fixed ~100 ns).
 *
 * 4 is chosen well BELOW the measured ratio, because a weight that is too low only makes the meter
 * generous while one that is too high starts refusing real documents. At 4, `maxWork` is a ceiling
 * of 16 M element visits, which a BEAST file cannot reach inside `maxChars`: the smallest sequence
 * element is about 32 characters, so a 16 MiB document holds at most ~1.05 M elements, and the
 * port's seven passes over them cost 7.3 M visits = 29 M units, under half the budget.
 *
 * WEIGHT 1 WAS TRIED FIRST AND WAS NOT ENOUGH: at it, the 509-deep visit bomb ran 8.2 s before the
 * meter noticed, and a 16 MiB flat document of 4.2 M elements was ACCEPTED at 39% of the budget
 * after 1,055 ms of pure traversal.
 */
const VISIT_UNITS = 4;

/**
 * A meter for ONE document read. Every traversal below and every caller that re-reads element text
 * charges the same meter, so the bound is on the whole read rather than on any one pass.
 *
 * @param {{maxWork?: number}} [limits]
 * @returns {WorkBudget}
 */
export function createWorkBudget(limits = {}) {
	const max = Number(limits.maxWork ?? XML_LIMITS.maxWork);
	return { spent: 0, max: Number.isFinite(max) && max > 0 ? max : XML_LIMITS.maxWork };
}

/**
 * The one refusal the budget raises. Separated so the hot loops carry a comparison and a call, not
 * a string template.
 * @param {WorkBudget} budget
 * @returns {never}
 */
function overBudget(budget) {
	throw new XmlReadError(
		`Reading this XML costs more than ${budget.max} units of work (one element visited, or one ` +
			`character of element text re-read, is one unit) — it is small and shallow enough to accept ` +
			`but not cheap enough to read. The usual cause is <alignment> or <data> elements NESTED ` +
			`inside one another: the reader searches the whole subtree below EVERY one of them ` +
			`(dataset.py:123-126), so each extra level of nesting re-reads every sequence again. Put ` +
			`the alignments side by side rather than inside one another, or drop the sequences as a ` +
			`separate FASTA file and let the XML carry only the dates.`,
		{ reason: 'too_much_work' }
	);
}

/**
 * Charge `units` to a budget. `null` is accepted and charges nothing, so the traversals below stay
 * usable by a caller that has no document read to bound.
 *
 * @param {WorkBudget|null|undefined} budget
 * @param {number} units
 * @returns {void}
 * @throws {XmlReadError} `too_much_work` once the meter is over its limit
 */
export function chargeWork(budget, units) {
	if (!budget) return;
	budget.spent += units;
	if (budget.spent > budget.max) overBudget(budget);
}

// =================================================================================================
// The three traversals `parse_beast_xml` uses, with ElementTree's exact semantics
// =================================================================================================

/**
 * `element.iter()`: self, then every descendant, in document order.
 *
 * ITERATIVE, NOT RECURSIVE, and that is a measurement rather than a preference: a `yield*` chain
 * costs O(depth) PER YIELDED ELEMENT, because every value is handed up through one delegation per
 * level, so a deep document paid the depth again on every element the caller looked at. An explicit
 * stack yields the same elements in the same order at O(1) each. Children are pushed in reverse so
 * the pop order is document order.
 *
 * @param {XmlElement} el
 * @param {WorkBudget} [budget] charged one unit per element visited
 * @returns {Generator<XmlElement>}
 */
export function* iterElements(el, budget) {
	/** @type {XmlElement[]} */
	const stack = [el];
	while (stack.length > 0) {
		const node = stack.pop();
		if (budget !== undefined && budget !== null) {
			budget.spent += VISIT_UNITS;
			if (budget.spent > budget.max) overBudget(budget);
		}
		yield node;
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
}

/**
 * `element.findall('.//tag')`: every DESCENDANT with that tag, self excluded, document order.
 *
 * Written as its own stack walk rather than over `iterElements`: this is the call `parse_beast_xml`
 * makes once per alignment node (dataset.py:126), so it is the inner loop of the quadratic the
 * budget exists to bound, and a generator hand-off per element is measurable there.
 *
 * @param {XmlElement} el
 * @param {string} tag
 * @param {WorkBudget} [budget] charged one unit per element visited
 * @returns {XmlElement[]}
 */
export function findAllDescendants(el, tag, budget) {
	/** @type {XmlElement[]} */
	const out = [];
	/** @type {XmlElement[]} */
	const stack = [el];
	while (stack.length > 0) {
		const node = stack.pop();
		if (budget !== undefined && budget !== null) {
			budget.spent += VISIT_UNITS;
			if (budget.spent > budget.max) overBudget(budget);
		}
		if (node !== el && node.tag === tag) out.push(node);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return out;
}

/**
 * `element.find('./tag')`: the FIRST direct child with that tag, or null.
 * @param {XmlElement} el
 * @param {string} tag
 * @param {WorkBudget} [budget] charged one unit per child examined
 * @returns {XmlElement|null}
 */
export function findChild(el, tag, budget) {
	const children = el.children;
	for (let i = 0; i < children.length; i++) {
		if (budget !== undefined && budget !== null) {
			budget.spent += VISIT_UNITS;
			if (budget.spent > budget.max) overBudget(budget);
		}
		if (children[i].tag === tag) return children[i];
	}
	return null;
}
