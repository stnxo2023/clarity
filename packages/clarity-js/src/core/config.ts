import { type Config, Time } from "@clarity-types/core";

const config: Config = {
    projectId: null,
    delay: 1 * Time.Second,
    lean: false,
    lite: false,
    track: true,
    content: true,
    drop: [],
    mask: [],
    unmask: [],
    regions: [],
    cookies: [],
    fraud: true,
    checksum: [],
    report: null,
    upload: null,
    fallback: null,
    upgrade: null,
    action: null,
    dob: null,
    delayDom: false,
    throttleDom: true,
    conversions: false,
    includeSubdomains: true,
};

export default config;
