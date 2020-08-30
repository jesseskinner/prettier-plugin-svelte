import { FastPath, Doc, doc, ParserOptions } from 'prettier';
import { Node, MustacheTagNode, IfBlockNode, AttributeNode } from './nodes';
import { isASTNode, isPreTagContent } from './helpers';
import { extractAttributes } from '../lib/extractAttributes';
import { getText } from '../lib/getText';
import { parseSortOrder, SortOrderPart } from '../options';
import { hasSnippedContent, unsnipContent } from '../lib/snipTagContent';
import { selfClosingTags, formattableAttributes } from '../lib/elements';
import {
    canBreakBefore,
    canBreakAfter,
    isInlineElement,
    isInlineNode,
    isEmptyNode,
} from './node-helpers';
import {
    isLine,
    isLineDiscardedIfLonely,
    isEmptyGroup,
    trim,
    trimLeft,
    trimRight,
} from './doc-helpers';

const {
    concat,
    join,
    line,
    group,
    indent,
    dedent,
    softline,
    hardline,
    fill,
    breakParent,
    literalline,
} = doc.builders;

export type PrintFn = (path: FastPath) => Doc;

declare module 'prettier' {
    export namespace doc {
        namespace builders {
            interface Line {
                keepIfLonely?: boolean;
            }
        }
    }
}

let ignoreNext = false;

const keepIfLonelyLine = { ...line, keepIfLonely: true, hard: true };

export function print(path: FastPath, options: ParserOptions, print: PrintFn): Doc {
    const n = path.getValue();
    if (!n) {
        return '';
    }

    if (isASTNode(n)) {
        const parts: doc.builders.Doc[] = [];
        const addParts: Record<SortOrderPart, () => void> = {
            scripts() {
                if (n.module) {
                    n.module.type = 'Script';
                    n.module.attributes = extractAttributes(getText(n.module, options));
                    parts.push(path.call(print, 'module'));
                }
                if (n.instance) {
                    n.instance.type = 'Script';
                    n.instance.attributes = extractAttributes(getText(n.instance, options));

                    const contentAttribute = (n.instance.attributes as AttributeNode[]).find(
                        (n) => n.name === '✂prettier:content✂',
                    );
                    if (!contentAttribute) {
                        throw new Error('No content attribute on script tag');
                    }

                    parts.push(path.call(print, 'instance'));
                }
            },
            styles() {
                if (n.css) {
                    n.css.type = 'Style';
                    n.css.content.type = 'StyleProgram';
                    parts.push(path.call(print, 'css'));
                }
            },
            markup() {
                const htmlDoc = path.call(print, 'html');
                if (htmlDoc) {
                    parts.push(htmlDoc);
                }
            },
        };
        parseSortOrder(options.svelteSortOrder).forEach((p) => addParts[p]());
        return group(join(hardline, parts));
    }

    const [open, close] = options.svelteStrictMode ? ['"{', '}"'] : ['{', '}'];
    const node = n as Node;

    if (ignoreNext && (node.type !== 'Text' || !isEmptyNode(node))) {
        ignoreNext = false;
        return concat(
            options.originalText
                .slice(options.locStart(node), options.locEnd(node))
                .split('\n')
                .flatMap((o, i) => (i == 0 ? o : [literalline, o])),
        );
    }

    switch (node.type) {
        case 'Fragment':
            const children = node.children;

            if (children.length === 0 || children.every(isEmptyNode)) {
                return '';
            }

            if (!isPreTagContent(path)) {
                return concat([...trim(printChildren(path, print), isLine), hardline]);
            } else {
                return concat(printChildren(path, print));
            }
        case 'Text':
            if (!isPreTagContent(path)) {
                if (isEmptyNode(node)) {
                    return {
                        /**
                         * Empty (whitespace-only) text nodes are collapsed into a single `line`,
                         * which will be rendered as a single space if this node's group fits on a
                         * single line. This follows how vanilla HTML is handled both by browsers and
                         * by Prettier core.
                         */
                        ...line,

                        /**
                         * A text node is considered lonely if it is in a group without other inline
                         * elements, such as the line breaks between otherwise consecutive HTML tags.
                         * Text nodes that are both empty and lonely are discarded unless they have at
                         * least one empty line (i.e. at least two linebreak sequences). This is to
                         * allow for flexible grouping of HTML tags in a particular indentation level,
                         * and is similar to how vanilla HTML is handled in Prettier core.
                         */
                        keepIfLonely: /\n\r?\s*\n\r?/.test(node.raw || node.data),
                    };
                }

                /**
                 * For non-empty text nodes each sequence of non-whitespace characters (effectively,
                 * each "word") is joined by a single `line`, which will be rendered as a single space
                 * until this node's current line is out of room, at which `fill` will break at the
                 * most convenient instance of `line`.
                 */
                return fill(splitTextToDocs(node.raw || node.data));
            } else {
                return node.data;
            }
        case 'Element':
        case 'InlineComponent':
        case 'Slot':
        case 'Window':
        case 'Head':
        case 'Title': {
            const isEmpty = node.children.every((child) => isEmptyNode(child));

            const isSelfClosingTag =
                isEmpty &&
                (!options.svelteStrictMode ||
                    node.type !== 'Element' ||
                    selfClosingTags.indexOf(node.name) !== -1);

            return group(
                concat([
                    '<',
                    node.name,

                    indent(
                        group(
                            concat([
                                node.type === 'InlineComponent' && node.expression
                                    ? concat([
                                          line,
                                          'this=',
                                          open,
                                          printJS(path, print, 'expression'),
                                          close,
                                      ])
                                    : '',
                                ...path.map((childPath) => childPath.call(print), 'attributes'),
                                options.svelteBracketNewLine
                                    ? dedent(isSelfClosingTag ? line : softline)
                                    : '',
                            ]),
                        ),
                    ),

                    ...(isSelfClosingTag
                        ? [options.svelteBracketNewLine ? '' : ' ', `/>`]
                        : [
                              '>',
                              isEmpty
                                  ? ''
                                  : isInlineElement(node) || isPreTagContent(path)
                                  ? printIndentedPreservingWhitespace(path, print)
                                  : printIndentedWithNewlines(path, print),
                              `</${node.name}>`,
                          ]),
                ]),
            );
        }
        case 'Options':
        case 'Body':
            return group(
                concat([
                    '<',
                    node.name,

                    indent(
                        group(concat(path.map((childPath) => childPath.call(print), 'attributes'))),
                    ),

                    ' />',
                ]),
            );
        case 'Identifier':
            return node.name;
        case 'AttributeShorthand': {
            return node.expression.name;
        }
        case 'Attribute': {
            const hasLoneMustacheTag =
                node.value !== true &&
                node.value.length === 1 &&
                node.value[0].type === 'MustacheTag';
            let isAttributeShorthand =
                node.value !== true &&
                node.value.length === 1 &&
                node.value[0].type === 'AttributeShorthand';

            // Convert a={a} into {a}
            if (hasLoneMustacheTag) {
                const expression = (node.value as [MustacheTagNode])[0].expression;
                isAttributeShorthand =
                    expression.type === 'Identifier' && expression.name === node.name;
            }

            if (isAttributeShorthand && options.svelteAllowShorthand) {
                return concat([line, '{', node.name, '}']);
            } else {
                const def: Doc[] = [line, node.name];
                if (node.value !== true) {
                    def.push('=');
                    const quotes = !hasLoneMustacheTag || options.svelteStrictMode;

                    quotes && def.push('"');

                    const valueDocs = path.map((childPath) => childPath.call(print), 'value');

                    if (!quotes || !formattableAttributes.includes(node.name)) {
                        def.push(concat(valueDocs));
                    } else {
                        def.push(indent(group(concat(trim(valueDocs, isLine)))));
                    }

                    quotes && def.push('"');
                }
                return concat(def);
            }
        }
        case 'MustacheTag':
            return concat(['{', printJS(path, print, 'expression'), '}']);
        case 'IfBlock': {
            const def: Doc[] = [
                '{#if ',
                printJS(path, print, 'expression'),
                '}',
                printIndentedWithNewlines(path, print),
            ];

            if (node.else) {
                def.push(path.call(print, 'else'));
            }

            def.push('{/if}');

            return concat([group(concat(def)), breakParent]);
        }
        case 'ElseBlock': {
            // Else if
            const parent = path.getParentNode() as Node;

            if (
                node.children.length === 1 &&
                node.children[0].type === 'IfBlock' &&
                parent.type !== 'EachBlock'
            ) {
                const ifNode = node.children[0] as IfBlockNode;
                const def: Doc[] = [
                    '{:else if ',
                    path.map((ifPath) => printJS(path, print, 'expression'), 'children')[0],
                    '}',
                    path.map((ifPath) => printIndentedWithNewlines(ifPath, print), 'children')[0],
                ];

                if (ifNode.else) {
                    def.push(path.map((ifPath) => ifPath.call(print, 'else'), 'children')[0]);
                }
                return group(concat(def));
            }

            return group(concat(['{:else}', printIndentedWithNewlines(path, print)]));
        }
        case 'EachBlock': {
            const def: Doc[] = [
                '{#each ',
                printJS(path, print, 'expression'),
                ' as ',
                printJS(path, print, 'context'),
            ];

            if (node.index) {
                def.push(', ', node.index);
            }

            if (node.key) {
                def.push(' (', printJS(path, print, 'key'), ')');
            }

            def.push('}', printIndentedWithNewlines(path, print));

            if (node.else) {
                def.push(path.call(print, 'else'));
            }

            def.push('{/each}');

            return concat([group(concat(def)), breakParent]);
        }
        case 'AwaitBlock': {
            const hasPendingBlock = node.pending.children.some((n) => !isEmptyNode(n));
            const hasThenBlock = node.then.children.some((n) => !isEmptyNode(n));
            const hasCatchBlock = node.catch.children.some((n) => !isEmptyNode(n));

            let block = [];

            if (!hasPendingBlock && hasThenBlock) {
                block.push(
                    group(
                        concat([
                            '{#await ',
                            printJS(path, print, 'expression'),
                            ' then',
                            expandNode(node.value),
                            '}',
                        ]),
                    ),
                    indent(path.call(print, 'then')),
                );
            } else {
                block.push(group(concat(['{#await ', printJS(path, print, 'expression'), '}'])));

                if (hasPendingBlock) {
                    block.push(indent(path.call(print, 'pending')));
                }

                if (hasThenBlock) {
                    block.push(
                        group(concat(['{:then', expandNode(node.value), '}'])),
                        indent(path.call(print, 'then')),
                    );
                }
            }

            if (hasCatchBlock) {
                block.push(
                    group(concat(['{:catch', expandNode(node.error), '}'])),
                    indent(path.call(print, 'catch')),
                );
            }

            block.push('{/await}');

            return group(concat(block));
        }
        case 'ThenBlock':
        case 'PendingBlock':
        case 'CatchBlock':
            return concat([
                softline,
                ...trim(printChildren(path, print), isLine),
                dedent(softline),
            ]);
        case 'EventHandler':
            return concat([
                line,
                'on:',
                node.name,
                node.modifiers && node.modifiers.length
                    ? concat(['|', join('|', node.modifiers)])
                    : '',
                node.expression
                    ? concat(['=', open, printJS(path, print, 'expression'), close])
                    : '',
            ]);
        case 'Binding':
            return concat([
                line,
                'bind:',
                node.name,
                node.expression.type === 'Identifier' && node.expression.name === node.name
                    ? ''
                    : concat(['=', open, printJS(path, print, 'expression'), close]),
            ]);
        case 'Class':
            return concat([
                line,
                'class:',
                node.name,
                node.expression.type === 'Identifier' && node.expression.name === node.name
                    ? ''
                    : concat(['=', open, printJS(path, print, 'expression'), close]),
            ]);
        case 'Let':
            return concat([
                line,
                'let:',
                node.name,
                // shorthand let directives have `null` expressions
                !node.expression ||
                (node.expression.type === 'Identifier' && node.expression.name === node.name)
                    ? ''
                    : concat(['=', open, printJS(path, print, 'expression'), close]),
            ]);
        case 'DebugTag':
            return concat([
                '{@debug',
                node.identifiers.length > 0
                    ? concat([' ', join(', ', path.map(print, 'identifiers'))])
                    : '',
                '}',
            ]);
        case 'Ref':
            return concat([line, 'ref:', node.name]);
        case 'Comment': {
            let text = node.data;
            ignoreNext = text.trim() === 'prettier-ignore';
            if (hasSnippedContent(text)) {
                text = unsnipContent(text);
            }

            return group(concat(['<!--', text, '-->']));
        }
        case 'Transition':
            const kind = node.intro && node.outro ? 'transition' : node.intro ? 'in' : 'out';
            return concat([
                line,
                kind,
                ':',
                node.name,
                node.modifiers && node.modifiers.length
                    ? concat(['|', join('|', node.modifiers)])
                    : '',
                node.expression
                    ? concat(['=', open, printJS(path, print, 'expression'), close])
                    : '',
            ]);
        case 'Action':
            return concat([
                line,
                'use:',
                node.name,
                node.expression
                    ? concat(['=', open, printJS(path, print, 'expression'), close])
                    : '',
            ]);
        case 'Animation':
            return concat([
                line,
                'animate:',
                node.name,
                node.expression
                    ? concat(['=', open, printJS(path, print, 'expression'), close])
                    : '',
            ]);
        case 'RawMustacheTag':
            return concat(['{@html ', printJS(path, print, 'expression'), '}']);
        case 'Spread':
            return concat([line, '{...', printJS(path, print, 'expression'), '}']);
    }

    console.error(JSON.stringify(node, null, 4));
    throw new Error('unknown node type: ' + node.type);
}

function printChildren(path: FastPath, print: PrintFn): Doc[] {
    let childDocs: Doc[] = [];
    let currentGroup: { doc: Doc; node: Node }[] = [];
    // the index of the last child doc we could add a linebreak after
    let lastBreakIndex = -1;

    const isPreformat = isPreTagContent(path);

    /**
     * Call when reaching a point where a linebreak is possible. Will
     * put all `childDocs` since the last possible linebreak position
     * into a `concat` to avoid them breaking.
     */
    function linebreakPossible() {
        if (lastBreakIndex >= 0 && lastBreakIndex < childDocs.length - 1) {
            childDocs = childDocs
                .slice(0, lastBreakIndex)
                .concat(concat(childDocs.slice(lastBreakIndex)));
        }

        lastBreakIndex = -1;
    }

    /**
     * Add a document to the output.
     * @param childDoc null means do not add anything but allow for the possibility of a linebreak here.
     */
    function outputChildDoc(childDoc: Doc | null, fromNodes: Node[]) {
        if (!isPreformat) {
            const firstNode = fromNodes[0];
            const lastNode = fromNodes[fromNodes.length - 1];

            if (!childDoc || canBreakBefore(firstNode)) {
                linebreakPossible();

                const lastChild = childDocs[childDocs.length - 1];

                // separate children by softlines, but not if the children are already lines.
                // one exception: allow for a line break before "keepIfLonely" lines because they represent an empty line
                if (
                    childDoc != null &&
                    !isLineDiscardedIfLonely(childDoc) &&
                    lastChild != null &&
                    !isLine(lastChild)
                ) {
                    childDocs.push(softline);
                }
            }

            if (lastBreakIndex < 0 && childDoc && !canBreakAfter(lastNode)) {
                lastBreakIndex = childDocs.length;
            }
        }

        if (childDoc) {
            childDocs.push(childDoc);
        }
    }

    function lastChildDocProduced() {
        // line breaks are ok after last child
        outputChildDoc(null, []);
    }

    /**
     * Sequences of inline nodes (currently, `TextNode`s and `MustacheTag`s) are collected into
     * groups and printed as a single `Fill` doc so that linebreaks as a result of sibling block
     * nodes (currently, all HTML elements) don't cause those inline sequences to break
     * prematurely. This is particularly important for whitespace sensitivity, as it is often
     * desired to have text directly wrapping a mustache tag without additional whitespace.
     */
    function flush() {
        let groupDocs = currentGroup.map((item) => item.doc);
        const groupNodes = currentGroup.map((item) => item.node);

        for (let doc of extractOutermostNewlines(groupDocs)) {
            outputChildDoc(doc, groupNodes);
        }

        currentGroup = [];
    }

    path.each((childPath) => {
        const childNode = childPath.getValue() as Node;
        const childDoc = childPath.call(print);

        if (isInlineNode(childNode)) {
            currentGroup.push({ doc: childDoc, node: childNode });
        } else {
            flush();

            outputChildDoc(isLine(childDoc) ? childDoc : concat([breakParent, childDoc]), [
                childNode,
            ]);
        }
    }, 'children');

    flush();
    lastChildDocProduced();

    return childDocs;
}

/**
 * Print the nodes in `path` indented and with leading and trailing newlines.
 */
function printIndentedWithNewlines(path: FastPath, print: PrintFn): Doc {
    return indent(
        concat([softline, ...trim(printChildren(path, print), isLine), dedent(softline)]),
    );
}

/**
 * Print the nodes in `path` indented but without adding any leading or trailing newlines.
 */
function printIndentedPreservingWhitespace(path: FastPath, print: PrintFn) {
    return indent(concat(dedentFinalNewline(printChildren(path, print))));
}

/**
 * Split the text into words separated by whitespace. Replace the whitespaces by lines,
 * collapsing multiple whitespaces into a single line.
 *
 * If the text starts or ends with multiple newlines, those newlines should be "keepIfLonely"
 * since we want double newlines in the output.
 */
function splitTextToDocs(text: string): Doc[] {
    let docs: Doc[] = text.split(/[\t\n\f\r ]+/);

    docs = join(line, docs).parts.filter((s) => s !== '');

    // if the text starts with two newlines, the first doc is already a newline. make it "keepIfLonely"
    if (text.match(/^([\t\f\r ]*\n){2}/)) {
        docs[0] = keepIfLonelyLine;
    }

    // if the text ends with two newlines, the last doc is already a newline. make it "keepIfLonely"
    if (text.match(/(\n[\t\f\r ]*){2}$/)) {
        docs[docs.length - 1] = keepIfLonelyLine;
    }

    return docs;
}

/**
 * If there is a trailing newline, pull it out and put it inside a `dedent`. This is used
 * when we want to preserve whitespace, but still indent the newline if there is one
 * (e.g. for `<b>1\n</b>` the `</b>` will be on its own line; for `<b>1</b>` it can't
 * because it would introduce new whitespace)
 */
function dedentFinalNewline(docs: Doc[]): Doc[] {
    const trimmedRight = trimRight(docs, isLine);

    if (trimmedRight) {
        return [...docs, dedent(trimmedRight[trimmedRight.length - 1])];
    } else {
        return docs;
    }
}

/**
 * Pull out any nested leading or trailing lines and put them at the top level.
 */

function extractOutermostNewlines(docs: Doc[]): Doc[] {
    const leadingLines: Doc[] = trimLeft(docs, isLine) || [];
    const trailingLines: Doc[] = trimRight(docs, isLine) || [];

    return [
        ...leadingLines,
        ...(!isEmptyGroup(docs) ? [fill(docs)] : ([] as Doc[])),
        ...trailingLines,
    ];
}

function printJS(path: FastPath, print: PrintFn, name?: string) {
    if (!name) {
        path.getValue().isJS = true;
        return path.call(print);
    }

    path.getValue()[name].isJS = true;
    return path.call(print, name);
}

function expandNode(node): string {
    if (node === null) {
        return '';
    }

    if (typeof node === 'string') {
        // pre-v3.20 AST
        return ' ' + node;
    }

    switch (node.type) {
        case 'ArrayPattern':
            return ' [' + node.elements.map(expandNode).join(',').slice(1) + ']';
        case 'AssignmentPattern':
            return expandNode(node.left) + ' =' + expandNode(node.right);
        case 'Identifier':
            return ' ' + node.name;
        case 'Literal':
            return ' ' + node.raw;
        case 'ObjectPattern':
            return ' {' + node.properties.map(expandNode).join(',') + ' }';
        case 'Property':
            if (node.value.type === 'ObjectPattern') {
                return ' ' + node.key.name + ':' + expandNode(node.value);
            } else {
                return expandNode(node.value);
            }
        case 'RestElement':
            return ' ...' + node.argument.name;
    }

    console.error(JSON.stringify(node, null, 4));
    throw new Error('unknown node type: ' + node.type);
}
