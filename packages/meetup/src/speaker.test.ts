import { describe, expect, it } from "bun:test";
import type { NormalizedSpeaker } from "@coopkit/core";
import { classifySocialUrl, speakerDetailsFrom } from "./speaker.js";

describe("classifySocialUrl", () => {
  it("maps known hosts to Meetup's service enum", () => {
    expect(classifySocialUrl("https://www.linkedin.com/in/ahmadsharif/")?.service).toBe("LINKEDIN");
    expect(classifySocialUrl("https://twitter.com/someone")?.service).toBe("TWITTER");
    expect(classifySocialUrl("https://x.com/someone")?.service).toBe("TWITTER");
    expect(classifySocialUrl("https://www.instagram.com/someone")?.service).toBe("INSTAGRAM");
  });

  it("falls back to OTHER for a personal site", () => {
    expect(classifySocialUrl("https://www.spertus.edu/")?.service).toBe("OTHER");
    expect(classifySocialUrl("https://twoscomplement.org/")?.service).toBe("OTHER");
  });

  it("keeps the whole URL as the identifier", () => {
    const url = "https://www.linkedin.com/in/duxi90/";
    expect(classifySocialUrl(url)?.identifier).toBe(url);
  });

  it("does not match a host that merely contains a service name", () => {
    expect(classifySocialUrl("https://notlinkedin.com/x")?.service).toBe("OTHER");
    expect(classifySocialUrl("https://linkedin.com.evil.test/x")?.service).toBe("OTHER");
  });

  it("matches subdomains of a service", () => {
    expect(classifySocialUrl("https://de.linkedin.com/in/someone")?.service).toBe("LINKEDIN");
  });

  it("returns undefined for something that is not a URL", () => {
    expect(classifySocialUrl("@handle")).toBeUndefined();
    expect(classifySocialUrl("")).toBeUndefined();
  });
});

describe("speakerDetailsFrom", () => {
  const speaker: NormalizedSpeaker = {
    name: "Andy Soffer",
    bioMarkdown: "A lapsed mathematician turned software engineer.",
  };

  it("returns undefined when there is no speaker", () => {
    expect(speakerDetailsFrom(undefined)).toBeUndefined();
  });

  it("returns undefined without a bio, since Meetup requires a description", () => {
    expect(speakerDetailsFrom({ name: "Andy Soffer" })).toBeUndefined();
    expect(speakerDetailsFrom({ name: "Andy Soffer", bioMarkdown: "   " })).toBeUndefined();
  });

  it("returns undefined without a name", () => {
    expect(speakerDetailsFrom({ name: "  ", bioMarkdown: "bio" })).toBeUndefined();
  });

  it("maps name and bio across", () => {
    expect(speakerDetailsFrom(speaker)).toEqual({
      name: "Andy Soffer",
      description: "A lapsed mathematician turned software engineer.",
    });
  });

  it("omits socialNetworks when there are none", () => {
    const details = speakerDetailsFrom(speaker);
    expect(details && "socialNetworks" in details).toBe(false);
  });

  it("includes classified social networks", () => {
    const details = speakerDetailsFrom({
      ...speaker,
      socialUrls: ["https://www.linkedin.com/in/someone/", "https://example.test/"],
    });
    expect(details?.socialNetworks).toEqual([
      { service: "LINKEDIN", identifier: "https://www.linkedin.com/in/someone/" },
      { service: "OTHER", identifier: "https://example.test/" },
    ]);
  });

  it("drops unclassifiable entries rather than failing", () => {
    const details = speakerDetailsFrom({
      ...speaker,
      socialUrls: ["not a url", "https://www.linkedin.com/in/someone/"],
    });
    expect(details?.socialNetworks).toEqual([
      { service: "LINKEDIN", identifier: "https://www.linkedin.com/in/someone/" },
    ]);
  });
});
