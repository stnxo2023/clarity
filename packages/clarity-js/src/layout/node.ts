import { Code, Dimension, Severity } from "@clarity-types/data";
import { Constant, Source } from "@clarity-types/layout";
import * as event from "@src/core/event";
import * as dimension from "@src/data/dimension";
import { electron } from "@src/data/metadata";
import * as internal from "@src/diagnostic/internal";
import * as interaction from "@src/interaction";
import * as mutation from "@src/layout/mutation";
import * as schema from "@src/layout/schema";
import { checkDocumentStyles } from "@src/layout/style";
import * as dom from "./dom";

const IGNORE_ATTRIBUTES = ["title", "alt", "onload", "onfocus", "onerror", "data-drupal-form-submit-last", "aria-label"];
const newlineRegex = /[\r\n]+/g;

export default function (inputNode: Node, source: Source, timestamp: number): Node {
    let node = inputNode;
    let child: Node = null;

    // Do not track this change if we are attempting to remove a node before discovering it
    if (source === Source.ChildListRemove && dom.has(node) === false) {
        return child;
    }

    // Special handling for text nodes that belong to style nodes
    if (source !== Source.Discover && node.nodeType === Node.TEXT_NODE && node.parentElement && node.parentElement.tagName === "STYLE") {
        node = node.parentNode;
    }

    const add = dom.has(node) === false;
    const call = add ? "add" : "update";
    let parent = node.parentElement ? node.parentElement : null;
    const insideFrame = node.ownerDocument !== document;
    switch (node.nodeType) {
        case Node.DOCUMENT_TYPE_NODE: {
            parent = insideFrame && node.parentNode ? dom.iframe(node.parentNode) : parent;
            const docTypePrefix = insideFrame ? Constant.IFramePrefix : Constant.Empty;
            const doctype = node as DocumentType;
            const docName = doctype.name ? doctype.name : Constant.HTML;
            const docAttributes = { name: docName, publicId: doctype.publicId, systemId: doctype.systemId };
            const docData = { tag: docTypePrefix + Constant.DocumentTag, attributes: docAttributes };
            dom[call](node, parent, docData, source);
            break;
        }
        case Node.DOCUMENT_NODE:
            // We check for regions in the beginning when discovering document and
            // later whenever there are new additions or modifications to DOM (mutations)
            if (node === document) {
                dom.parse(document);
            }
            checkDocumentStyles(node as Document, timestamp);
            observe(node as Document);
            break;
        case Node.DOCUMENT_FRAGMENT_NODE: {
            const shadowRoot = node as ShadowRoot;
            if (shadowRoot.host) {
                dom.parse(shadowRoot);
                const type = typeof shadowRoot.constructor;
                if (type === Constant.Function && shadowRoot.constructor.toString().indexOf(Constant.NativeCode) >= 0) {
                    observe(shadowRoot);

                    // See: https://wicg.github.io/construct-stylesheets/ for more details on adoptedStyleSheets.
                    // At the moment, we are only able to capture "open" shadow DOM nodes. If they are closed, they are not accessible.
                    // In future we may decide to proxy "attachShadow" call to gain access, but at the moment, we don't want to
                    // cause any unintended side effect to the page. We will re-evaluate after we gather more real world data on this.
                    const style = Constant.Empty as string;
                    const fragmentData = { tag: Constant.ShadowDomTag, attributes: { style } };
                    dom[call](node, shadowRoot.host, fragmentData, source);
                } else {
                    // If the browser doesn't support shadow DOM natively, we detect that, and send appropriate tag back.
                    // The differentiation is important because we don't have to observe pollyfill shadow DOM nodes,
                    // the same way we observe real shadow DOM nodes (encapsulation provided by the browser).
                    dom[call](node, shadowRoot.host, { tag: Constant.PolyfillShadowDomTag, attributes: {} }, source);
                }
                checkDocumentStyles(node as Document, timestamp);
            }
            break;
        }
        case Node.TEXT_NODE:
            // In IE11 TEXT_NODE doesn't expose a valid parentElement property. Instead we need to lookup parentNode property.
            parent = parent ? parent : (node.parentNode as HTMLElement);
            // Account for this text node only if we are tracking the parent node
            // We do not wish to track text nodes for ignored parent nodes, like script tags
            // Also, we do not track text nodes for STYLE tags
            // The only exception is when we receive a mutation to remove the text node, in that case
            // parent will be null, but we can still process the node by checking it's an update call.
            if (call === "update" || (parent && dom.has(parent) && parent.tagName !== "STYLE" && parent.tagName !== "NOSCRIPT")) {
                const textData = { tag: Constant.TextTag, value: node.nodeValue };
                dom[call](node, parent, textData, source);
            }
            break;
        case Node.ELEMENT_NODE: {
            const element = node as HTMLElement;
            let tag = element.tagName;
            const attributes = getAttributes(element);
            // In some cases, external libraries like vue-fragment, can modify parentNode property to not be in sync with the DOM
            // For correctness, we first look at parentElement and if it not present then fall back to using parentNode
            parent = node.parentElement ? node.parentElement : node.parentNode ? (node.parentNode as HTMLElement) : null;
            // If we encounter a node that is part of SVG namespace, prefix the tag with SVG_PREFIX
            if (element.namespaceURI === Constant.SvgNamespace) {
                tag = Constant.SvgPrefix + tag;
            }

            switch (tag) {
                case "HTML": {
                    parent = insideFrame && parent ? dom.iframe(parent) : parent;
                    const htmlPrefix = insideFrame ? Constant.IFramePrefix : Constant.Empty;
                    const htmlData = { tag: htmlPrefix + tag, attributes };
                    dom[call](node, parent, htmlData, source);
                    break;
                }
                case "SCRIPT":
                    if (Constant.Type in attributes && attributes[Constant.Type] === Constant.JsonLD) {
                        try {
                            schema.ld(JSON.parse((element as HTMLScriptElement).text.replace(newlineRegex, Constant.Empty)));
                        } catch {
                            /* do nothing */
                        }
                    }
                    break;
                case "NOSCRIPT": {
                    // keeping the noscript tag but ignoring its contents. Some HTML markup relies on having these tags
                    // to maintain parity with the original css view, but we don't want to execute any noscript in Clarity
                    const noscriptData = { tag, attributes: {}, value: "" };
                    dom[call](node, parent, noscriptData, source);
                    break;
                }
                case "META": {
                    const key = Constant.Property in attributes ? Constant.Property : Constant.Name in attributes ? Constant.Name : null;
                    if (key && Constant.Content in attributes) {
                        const content = attributes[Constant.Content];
                        switch (attributes[key]) {
                            case Constant.ogTitle:
                                dimension.log(Dimension.MetaTitle, content);
                                break;
                            case Constant.ogType:
                                dimension.log(Dimension.MetaType, content);
                                break;
                            case Constant.Generator:
                                dimension.log(Dimension.Generator, content);
                                break;
                        }
                    }
                    break;
                }
                case "HEAD": {
                    const head = { tag, attributes };
                    const l = insideFrame && node.ownerDocument?.location ? node.ownerDocument.location : location;
                    head.attributes[Constant.Base] = `${l.protocol}//${l.host}${l.pathname}`;
                    dom[call](node, parent, head, source);
                    break;
                }
                case "BASE": {
                    // Override the auto detected base path to explicit value specified in this tag
                    const baseHead = dom.get(node.parentElement);
                    if (baseHead) {
                        // We create "a" element so we can generate protocol and hostname for relative paths like "/path/"
                        const a = document.createElement("a");
                        a.href = attributes.href;
                        baseHead.data.attributes[Constant.Base] = `${a.protocol}//${a.host}${a.pathname}`;
                    }
                    break;
                }
                case "STYLE": {
                    const styleData = { tag, attributes, value: getStyleValue(element as HTMLStyleElement) };
                    dom[call](node, parent, styleData, source);
                    break;
                }
                case "IFRAME": {
                    const iframe = node as HTMLIFrameElement;
                    const frameData = { tag, attributes };
                    if (dom.sameorigin(iframe)) {
                        mutation.monitor(iframe);
                        frameData.attributes[Constant.SameOrigin] = "true";
                        if (iframe.contentDocument && iframe.contentWindow && iframe.contentDocument.readyState !== "loading") {
                            child = iframe.contentDocument;
                        }
                    }
                    if (source === Source.ChildListRemove) {
                        removeObserver(iframe);
                    }
                    dom[call](node, parent, frameData, source);
                    break;
                }
                case "LINK": {
                    // electron stylesheets reference the local file system - translating those
                    // to inline styles so playback can work
                    if (electron && attributes.rel === Constant.StyleSheet) {
                        for (const styleSheetIndex in Object.keys(document.styleSheets)) {
                            const currentStyleSheet = document.styleSheets[styleSheetIndex];
                            if (currentStyleSheet.ownerNode === element) {
                                const syntheticStyleData = { tag: "STYLE", attributes, value: getCssRules(currentStyleSheet) };
                                dom[call](node, parent, syntheticStyleData, source);
                                break;
                            }
                        }
                        break;
                    }
                    // for links that aren't electron style sheets we can process them normally
                    const linkData = { tag, attributes };
                    dom[call](node, parent, linkData, source);
                    break;
                }
                case "VIDEO":
                case "AUDIO":
                case "SOURCE": {
                    // Ignoring any base64 src attribute for media elements to prevent big unused tokens to be sent and shock the network
                    if (Constant.Src in attributes && attributes[Constant.Src].startsWith("data:")) {
                        attributes[Constant.Src] = "";
                    }
                    const mediaTag = { tag, attributes };
                    dom[call](node, parent, mediaTag, source);
                    break;
                }
                default: {
                    const data = { tag, attributes };
                    if (element.shadowRoot) {
                        child = element.shadowRoot;
                    }
                    dom[call](node, parent, data, source);
                    break;
                }
            }
            break;
        }
        default:
            break;
    }
    return child;
}

function observe(root: Document | ShadowRoot): void {
    if (dom.has(root) || event.has(root)) {
        return;
    }
    mutation.observe(root); // Observe mutations for this root node
    interaction.observe(root); // Observe interactions for this root node
}

export function removeObserver(root: HTMLIFrameElement): void {
    // iframes will have load event listeners and they should be removed when iframe is removed
    // from the document
    event.unbind(root);
    const { doc = null, win = null } = dom.iframeContent(root) || {};

    if (win) {
        // For iframes, scroll event is observed on content window and this needs to be removed as well
        event.unbind(win);
    }

    if (doc) {
        // When an iframe is removed, we should also remove all listeners attached to its document
        // to avoid memory leaks.
        event.unbind(doc);
        mutation.disconnect(doc);

        // Remove iframe and content document from maps tracking them
        dom.removeIFrame(root, doc);
    }
}

function getStyleValue(style: HTMLStyleElement): string {
    // Call trim on the text content to ensure we do not process white spaces ( , \n, \r\n, \t, etc.)
    // Also, check if stylesheet has any data-* attribute, if so process rules instead of looking up text
    // Additionally, check if style node has an id - if so it's at a high risk to have experienced dynamic
    // style updates which would make the textContent out of date with its true style contribution.
    let value = style.textContent ? style.textContent.trim() : Constant.Empty;
    const dataset = style.dataset ? Object.keys(style.dataset).length : 0;
    if (value.length === 0 || dataset > 0 || style.id.length > 0) {
        value = getCssRules(style.sheet as CSSStyleSheet);
    }
    return value;
}

export function getCssRules(sheet: CSSStyleSheet): string {
    let value = Constant.Empty as string;
    let cssRules = null;
    // Firefox throws a SecurityError when trying to access cssRules of a stylesheet from a different domain
    try {
        cssRules = sheet ? sheet.cssRules : [];
    } catch (e) {
        internal.log(Code.CssRules, Severity.Warning, e ? e.name : null);
        if (e && e.name !== "SecurityError") {
            throw e;
        }
    }

    if (cssRules !== null) {
        for (let i = 0; i < cssRules.length; i++) {
            value += cssRules[i].cssText;
        }
    }

    return value;
}

function getAttributes(element: HTMLElement): { [key: string]: string } {
    const output = {};
    const attributes = element.attributes;
    if (attributes && attributes.length > 0) {
        for (let i = 0; i < attributes.length; i++) {
            const name = attributes[i].name;
            if (IGNORE_ATTRIBUTES.indexOf(name) < 0) {
                output[name] = attributes[i].value;
            }
        }
    }

    // For INPUT tags read the dynamic "value" property if an explicit "value" attribute is not set
    if (element.tagName === Constant.InputTag && !(Constant.Value in output) && (element as HTMLInputElement).value) {
        output[Constant.Value] = (element as HTMLInputElement).value;
    }

    return output;
}
